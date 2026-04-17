import type {
  InstanceWithZApi,
  MessagingProviderInstanceRepository,
} from "../../db/repositories/messaging-provider-instance-repository.ts";
import { maskToken } from "./mask.ts";
import {
  ConflictError,
  type CreateZApiInstanceInput,
  type InstanceView,
  type ListFilters,
  type PaginationMeta,
} from "./types.ts";

export class MessagingProviderInstanceService {
  constructor(private readonly repo: MessagingProviderInstanceRepository) {}

  async createZApiInstance(input: CreateZApiInstanceInput): Promise<InstanceView> {
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
          safetyTtlMs: input.safetyTtlMs ?? null,
          heartbeatIntervalMs: input.heartbeatIntervalMs ?? null,
        },
        {
          zapiInstanceId: input.zapiInstanceId,
          instanceToken: input.instanceToken,
          webhookBaseUrl: input.webhookBaseUrl ?? null,
        },
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
    safetyTtlMs: base.safetyTtlMs,
    heartbeatIntervalMs: base.heartbeatIntervalMs,
    createdAt: base.createdAt.toISOString(),
    updatedAt: base.updatedAt.toISOString(),
    archivedAt: base.archivedAt ? base.archivedAt.toISOString() : null,
    zapi: zapi
      ? {
          zapiInstanceId: zapi.zapiInstanceId,
          instanceTokenMasked: maskToken(zapi.instanceToken),
          webhookBaseUrl: zapi.webhookBaseUrl,
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
