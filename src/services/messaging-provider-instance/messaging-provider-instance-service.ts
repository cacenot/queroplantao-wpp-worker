import type { Redis } from "ioredis";
import type {
  ConnectionEventInsert,
  DeviceSnapshotInsert,
  InstanceWithZApi,
  MessagingProviderInstanceRepository,
  ZApiConnectionState,
  ZApiCurrentStatusUpdate,
} from "../../db/repositories/messaging-provider-instance-repository.ts";
import { logger } from "../../lib/logger.ts";
import type {
  ZApiDeviceSnapshot,
  ZApiMeSnapshot,
  ZApiStatusSnapshot,
} from "../provider-registry/schemas.ts";
import { maskToken } from "./mask.ts";
import {
  ConflictError,
  type CreateZApiInstanceInput,
  type InstanceView,
  type ListFilters,
  type PaginationMeta,
  type UpdateZApiInstanceInput,
  ZApiRefreshError,
} from "./types.ts";

export interface ZApiClientCredentials {
  providerInstanceId: string;
  zapiInstanceId: string;
  instanceToken: string;
  customClientToken: string | null;
}

export interface ZApiRefreshClient {
  refreshSnapshot(): Promise<{
    me: ZApiMeSnapshot;
    device: ZApiDeviceSnapshot;
    status: ZApiStatusSnapshot;
  }>;
}

export type ZApiClientFactory = (credentials: ZApiClientCredentials) => ZApiRefreshClient;

export interface MessagingProviderInstanceServiceDeps {
  repo: MessagingProviderInstanceRepository;
  redis: Redis;
  clientFactory: ZApiClientFactory;
}

export class MessagingProviderInstanceService {
  private readonly repo: MessagingProviderInstanceRepository;
  private readonly redis: Redis;
  private readonly clientFactory: ZApiClientFactory;

  constructor(deps: MessagingProviderInstanceServiceDeps) {
    this.repo = deps.repo;
    this.redis = deps.redis;
    this.clientFactory = deps.clientFactory;
  }

  async createZApiInstance(input: CreateZApiInstanceInput): Promise<InstanceView> {
    // — 1. Fast-fail de duplicado (evita HTTP inútil)
    if (await this.repo.existsByZapiInstanceId(input.zapiInstanceId)) {
      throw new ConflictError("zapiInstanceId já cadastrado");
    }

    // — 2. Refresh síncrono fora da txn: HTTP não deve segurar conexão PG
    const snapshot = await this.runRefresh({
      providerInstanceId: "unknown",
      zapiInstanceId: input.zapiInstanceId,
      instanceToken: input.instanceToken,
      customClientToken: input.customClientToken ?? null,
    });

    // — 3. Txn curta: re-check de TOCTOU + inserts + status + eventos
    const id = await this.repo.withTransaction(async (tx) => {
      if (await this.repo.existsByZapiInstanceId(input.zapiInstanceId, tx)) {
        throw new ConflictError("zapiInstanceId já cadastrado");
      }

      const inserted = await this.repo.insertZApiInstance(
        {
          protocol: "whatsapp",
          providerKind: "whatsapp_zapi",
          displayName: input.displayName,
          executionStrategy: input.executionStrategy ?? "leased",
          redisKey: input.redisKey,
        },
        {
          zapiInstanceId: input.zapiInstanceId,
          instanceToken: input.instanceToken,
          customClientToken: input.customClientToken ?? null,
        },
        tx
      );

      await this.repo.updateZApiCurrentStatus(inserted.id, toStatusUpdate(snapshot), tx);
      await this.repo.insertConnectionEvent(
        inserted.id,
        toConnectionEvent(snapshot, "bootstrap"),
        tx
      );
      await this.repo.insertDeviceSnapshot(
        inserted.id,
        toDeviceSnapshotInsert(snapshot, "bootstrap"),
        tx
      );

      return inserted.id;
    });

    const row = await this.repo.findById(id);
    if (!row) {
      throw new Error("Instância recém-criada não encontrada — inconsistência inesperada");
    }

    return toInstanceView(row);
  }

  /**
   * PATCH: edita campos + refresh com credenciais efetivas (patch aplicado).
   *
   * Assimetria proposital vs `refreshZApiInstance`:
   * - Falha no refresh aqui normalmente indica credencial nova inválida
   *   digitada pelo usuário — rollback do patch e instância segue intacta.
   *   Não ejeta do pool porque o estado anterior provavelmente funcionava;
   *   mexer no pool com base em credencial errada derrubaria o que funciona.
   * - Se a instância de fato morreu, o webhook `disconnect` da Z-API avisa o
   *   worker; e o operador pode chamar `POST /:id/refresh` explicitamente.
   */
  async updateZApiInstance(
    id: string,
    patch: UpdateZApiInstanceInput
  ): Promise<InstanceView | null> {
    const existing = await this.repo.findById(id);
    if (!existing?.zapi) return null;
    const zapi = existing.zapi;

    // — 1. Credenciais efetivas (patch aplicado sobre o estado atual)
    const snapshot = await this.runRefresh({
      providerInstanceId: id,
      zapiInstanceId: zapi.zapiInstanceId,
      instanceToken: patch.instanceToken ?? zapi.instanceToken,
      customClientToken:
        patch.customClientToken !== undefined ? patch.customClientToken : zapi.customClientToken,
    });

    // — 2. Txn curta: patch + status + eventos
    await this.repo.withTransaction(async (tx) => {
      if (
        patch.displayName !== undefined ||
        patch.executionStrategy !== undefined ||
        patch.redisKey !== undefined
      ) {
        await this.repo.updateBase(
          id,
          {
            displayName: patch.displayName,
            executionStrategy: patch.executionStrategy,
            redisKey: patch.redisKey,
          },
          tx
        );
      }

      if (patch.instanceToken !== undefined || patch.customClientToken !== undefined) {
        await this.repo.updateZApiCredentials(
          id,
          {
            instanceToken: patch.instanceToken,
            customClientToken: patch.customClientToken,
          },
          tx
        );
      }

      await this.repo.updateZApiCurrentStatus(id, toStatusUpdate(snapshot), tx);
      await this.repo.insertConnectionEvent(id, toConnectionEvent(snapshot, "manual"), tx);
      await this.repo.insertDeviceSnapshot(id, toDeviceSnapshotInsert(snapshot, "manual"), tx);
    });

    const row = await this.repo.findById(id);
    return row ? toInstanceView(row) : null;
  }

  /**
   * POST /refresh: estado anterior era válido; uma falha agora implica que a
   * instância de fato caiu no provedor externo. Nesse caso ejetamos do pool
   * (marca `unreachable`, desabilita, remove do ZSet) para impedir que o worker
   * continue escolhendo uma instância quebrada.
   */
  async refreshZApiInstance(id: string): Promise<InstanceView | null> {
    const existing = await this.repo.findById(id);
    if (!existing?.zapi) return null;
    const zapi = existing.zapi;

    let snapshot: Awaited<ReturnType<ZApiRefreshClient["refreshSnapshot"]>>;
    try {
      snapshot = await this.clientFactory({
        providerInstanceId: id,
        zapiInstanceId: zapi.zapiInstanceId,
        instanceToken: zapi.instanceToken,
        customClientToken: zapi.customClientToken,
      }).refreshSnapshot();
    } catch (err) {
      const reason = errorMessage(err);
      logger.warn(
        { err, providerInstanceId: id, redisKey: existing.base.redisKey },
        "Refresh manual falhou — ejetando instância do pool"
      );

      await this.repo.markUnreachableAndDisable(id, reason);
      await this.redis
        .zrem(existing.base.redisKey, id)
        .catch((zErr) =>
          logger.warn({ err: zErr, providerInstanceId: id }, "Falha ao ejetar do Redis ZSet")
        );

      throw new ZApiRefreshError(reason, err);
    }

    await this.repo.withTransaction(async (tx) => {
      await this.repo.updateZApiCurrentStatus(id, toStatusUpdate(snapshot), tx);
      await this.repo.insertConnectionEvent(id, toConnectionEvent(snapshot, "manual"), tx);
      await this.repo.insertDeviceSnapshot(id, toDeviceSnapshotInsert(snapshot, "manual"), tx);
    });

    const row = await this.repo.findById(id);
    return row ? toInstanceView(row) : null;
  }

  async get(id: string): Promise<InstanceView | null> {
    const row = await this.repo.findById(id);
    return row ? toInstanceView(row) : null;
  }

  async list(
    filters: ListFilters,
    pagination: { limit: number; offset: number }
  ): Promise<{ data: InstanceView[]; pagination: PaginationMeta }> {
    const { rows, total } = await this.repo.list(filters, pagination);

    return {
      data: rows.map(toInstanceView),
      pagination: { ...pagination, total },
    };
  }

  async resolveProviderInstanceIdByZapiInstanceId(
    zapiInstanceExternalId: string
  ): Promise<string | null> {
    return this.repo.findProviderInstanceIdByZapiInstanceId(zapiInstanceExternalId);
  }

  async enable(id: string): Promise<InstanceView | null> {
    return this.setEnabledTransition(id, true);
  }

  async disable(id: string): Promise<InstanceView | null> {
    return this.setEnabledTransition(id, false);
  }

  private async setEnabledTransition(id: string, desired: boolean): Promise<InstanceView | null> {
    const existing = await this.repo.findById(id);
    if (!existing) return null;

    if (existing.base.isEnabled === desired) {
      return toInstanceView(existing);
    }

    const updatedBase = await this.repo.setEnabled(id, desired);
    if (!updatedBase) return null;

    return toInstanceView({ base: updatedBase, zapi: existing.zapi });
  }

  private async runRefresh(
    credentials: ZApiClientCredentials
  ): Promise<Awaited<ReturnType<ZApiRefreshClient["refreshSnapshot"]>>> {
    try {
      return await this.clientFactory(credentials).refreshSnapshot();
    } catch (err) {
      throw new ZApiRefreshError(errorMessage(err), err);
    }
  }
}

function toInstanceView(row: InstanceWithZApi): InstanceView {
  const { base, zapi } = row;

  return {
    id: base.id,
    protocol: base.protocol,
    providerKind: base.providerKind,
    displayName: base.displayName,
    isEnabled: base.isEnabled,
    executionStrategy: base.executionStrategy,
    redisKey: base.redisKey,
    createdAt: base.createdAt.toISOString(),
    updatedAt: base.updatedAt.toISOString(),
    archivedAt: base.archivedAt ? base.archivedAt.toISOString() : null,
    zapi: zapi
      ? {
          zapiInstanceId: zapi.zapiInstanceId,
          instanceTokenMasked: maskToken(zapi.instanceToken),
          customClientTokenMasked: zapi.customClientToken
            ? maskToken(zapi.customClientToken)
            : null,
          currentConnectionState: zapi.currentConnectionState,
          currentConnected: zapi.currentConnected,
          currentPhoneNumber: zapi.currentPhoneNumber,
          lastStatusSyncedAt: zapi.lastStatusSyncedAt
            ? zapi.lastStatusSyncedAt.toISOString()
            : null,
        }
      : null,
  };
}

function toStatusUpdate(snapshot: {
  me: ZApiMeSnapshot;
  device: ZApiDeviceSnapshot;
  status: ZApiStatusSnapshot;
}): ZApiCurrentStatusUpdate {
  return {
    currentConnectionState: resolveConnectionState(snapshot.status),
    currentStatusReason: snapshot.status.error ?? null,
    currentConnected: snapshot.status.connected,
    currentSmartphoneConnected: snapshot.status.smartphoneConnected,
    currentPhoneNumber: snapshot.me.phone ?? snapshot.device.phone ?? null,
    currentProfileName: snapshot.me.name ?? snapshot.device.name ?? null,
    currentProfileAbout: snapshot.me.about ?? snapshot.device.about ?? null,
    currentProfileImageUrl: snapshot.me.imgUrl ?? snapshot.device.imgUrl ?? null,
    currentOriginalDevice: snapshot.device.originalDevice ?? null,
    currentSessionId: snapshot.device.sessionId ?? null,
    currentDeviceSessionName: snapshot.device.device?.sessionName ?? null,
    currentDeviceModel: snapshot.device.device?.device_model ?? null,
    currentIsBusiness: snapshot.me.isBusiness ?? snapshot.device.isBusiness ?? null,
  };
}

// Só emite `connected | errored | disconnected`. Os estados `pending` e
// `unknown` são escritos pelo fluxo de webhook; `unreachable` pelo refresh
// manual em falha.
function resolveConnectionState(status: ZApiStatusSnapshot): ZApiConnectionState {
  if (status.connected) return "connected";
  if (status.error) return "errored";
  return "disconnected";
}

function toConnectionEvent(
  snapshot: { status: ZApiStatusSnapshot },
  source: "bootstrap" | "manual"
): ConnectionEventInsert {
  return {
    source,
    eventType: "refresh",
    connected: snapshot.status.connected,
    smartphoneConnected: snapshot.status.smartphoneConnected,
    statusReason: snapshot.status.error ?? null,
    providerOccurredAt: null,
    dedupeKey: null,
    rawPayload: snapshot.status,
  };
}

function toDeviceSnapshotInsert(
  snapshot: { me: ZApiMeSnapshot; device: ZApiDeviceSnapshot },
  source: "bootstrap" | "manual"
): DeviceSnapshotInsert {
  return {
    source,
    phoneNumber: snapshot.me.phone ?? snapshot.device.phone ?? null,
    profileName: snapshot.me.name ?? snapshot.device.name ?? null,
    profileAbout: snapshot.me.about ?? snapshot.device.about ?? null,
    profileImageUrl: snapshot.me.imgUrl ?? snapshot.device.imgUrl ?? null,
    originalDevice: snapshot.device.originalDevice ?? null,
    sessionId: snapshot.device.sessionId ?? null,
    deviceSessionName: snapshot.device.device?.sessionName ?? null,
    deviceModel: snapshot.device.device?.device_model ?? null,
    isBusiness: snapshot.me.isBusiness ?? snapshot.device.isBusiness ?? null,
    rawPayload: { me: snapshot.me, device: snapshot.device },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "Erro desconhecido ao chamar a Z-API";
}
