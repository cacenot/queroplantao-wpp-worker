import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type MessagingProviderInstance,
  messagingProviderInstances,
  type NewMessagingProviderInstance,
  type NewZApiInstance,
  type ZApiInstance,
  zapiInstanceConnectionEvents,
  zapiInstanceDeviceSnapshots,
  zapiInstances,
} from "../schema/provider-registry.ts";

type DbOrTx = Db;

export interface InstanceFilters {
  protocol?: "whatsapp" | "telegram";
  providerKind?: "whatsapp_zapi" | "whatsapp_whatsmeow" | "whatsapp_business_api" | "telegram_bot";
  isEnabled?: boolean;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface InstanceWithZApi {
  base: MessagingProviderInstance;
  zapi: ZApiInstance | null;
}

export interface EnabledZApiRow {
  providerId: string;
  displayName: string;
  executionStrategy: MessagingProviderInstance["executionStrategy"];
  redisKey: string;
  instanceId: string;
  instanceToken: string;
  customClientToken: string | null;
}

export type ZApiConnectionState =
  | "unknown"
  | "connected"
  | "disconnected"
  | "pending"
  | "errored"
  | "unreachable";

export interface ZApiCurrentStatusUpdate {
  currentConnectionState: ZApiConnectionState;
  currentStatusReason: string | null;
  currentConnected: boolean;
  currentSmartphoneConnected: boolean;
  currentPhoneNumber: string | null;
  currentProfileName: string | null;
  currentProfileAbout: string | null;
  currentProfileImageUrl: string | null;
  currentOriginalDevice: string | null;
  currentSessionId: number | null;
  currentDeviceSessionName: string | null;
  currentDeviceModel: string | null;
  currentIsBusiness: boolean | null;
}

export interface UpdateBasePatch {
  displayName?: string;
  executionStrategy?: MessagingProviderInstance["executionStrategy"];
  redisKey?: string;
}

export interface ConnectionEventInsert {
  source: "webhook" | "poll" | "bootstrap" | "manual";
  eventType: string;
  connected: boolean | null;
  smartphoneConnected: boolean | null;
  statusReason: string | null;
  providerOccurredAt: Date | null;
  dedupeKey: string | null;
  rawPayload: unknown;
}

export interface DeviceSnapshotInsert {
  source: "api_device" | "webhook" | "bootstrap" | "manual";
  observedAt?: Date;
  phoneNumber: string | null;
  profileName: string | null;
  profileAbout: string | null;
  profileImageUrl: string | null;
  originalDevice: string | null;
  sessionId: number | null;
  deviceSessionName: string | null;
  deviceModel: string | null;
  isBusiness: boolean | null;
  rawPayload: unknown;
}

export class MessagingProviderInstanceRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<InstanceWithZApi | null> {
    const rows = await this.db
      .select()
      .from(messagingProviderInstances)
      .leftJoin(
        zapiInstances,
        eq(zapiInstances.messagingProviderInstanceId, messagingProviderInstances.id)
      )
      .where(eq(messagingProviderInstances.id, id))
      .limit(1);

    const [row] = rows;
    if (!row) return null;

    return {
      base: row.messaging_provider_instances,
      zapi: row.zapi_instances,
    };
  }

  async list(
    filters: InstanceFilters,
    pagination: Pagination
  ): Promise<{ rows: InstanceWithZApi[]; total: number }> {
    const conditions = this.buildFilters(filters);

    const rows = await this.db
      .select()
      .from(messagingProviderInstances)
      .leftJoin(
        zapiInstances,
        eq(zapiInstances.messagingProviderInstanceId, messagingProviderInstances.id)
      )
      .where(conditions)
      .orderBy(
        desc(messagingProviderInstances.createdAt),
        asc(messagingProviderInstances.displayName)
      )
      .limit(pagination.limit)
      .offset(pagination.offset);

    const [totalRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messagingProviderInstances)
      .where(conditions);

    return {
      rows: rows.map((row) => ({
        base: row.messaging_provider_instances,
        zapi: row.zapi_instances,
      })),
      total: totalRow?.count ?? 0,
    };
  }

  async listEnabledZApiRows(): Promise<EnabledZApiRow[]> {
    return this.queryZApiRows({ onlyEnabled: true });
  }

  // Inclui instâncias com is_enabled=false (mas archived_at IS NULL). Usado pelo
  // bootstrap dos workers e CLIs que precisam operar em instâncias em onboarding —
  // o filtro por is_enabled passa a ser responsabilidade dos callsites que enfileiram
  // tráfego automatizado (delete/remove), não do registry.
  async listAllZApiRows(): Promise<EnabledZApiRow[]> {
    return this.queryZApiRows({ onlyEnabled: false });
  }

  private async queryZApiRows(opts: { onlyEnabled: boolean }): Promise<EnabledZApiRow[]> {
    const conditions = [
      eq(messagingProviderInstances.protocol, "whatsapp"),
      eq(messagingProviderInstances.providerKind, "whatsapp_zapi"),
      isNull(messagingProviderInstances.archivedAt),
    ];

    if (opts.onlyEnabled) {
      conditions.push(eq(messagingProviderInstances.isEnabled, true));
    }

    return this.db
      .select({
        providerId: messagingProviderInstances.id,
        displayName: messagingProviderInstances.displayName,
        executionStrategy: messagingProviderInstances.executionStrategy,
        redisKey: messagingProviderInstances.redisKey,
        instanceId: zapiInstances.zapiInstanceId,
        instanceToken: zapiInstances.instanceToken,
        customClientToken: zapiInstances.customClientToken,
      })
      .from(messagingProviderInstances)
      .innerJoin(
        zapiInstances,
        eq(zapiInstances.messagingProviderInstanceId, messagingProviderInstances.id)
      )
      .where(and(...conditions))
      .orderBy(asc(messagingProviderInstances.displayName), asc(zapiInstances.zapiInstanceId));
  }

  async findProviderInstanceIdByZapiInstanceId(zapiInstanceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: zapiInstances.messagingProviderInstanceId })
      .from(zapiInstances)
      .where(eq(zapiInstances.zapiInstanceId, zapiInstanceId))
      .limit(1);

    return row?.id ?? null;
  }

  async existsByZapiInstanceId(zapiInstanceId: string, tx?: DbOrTx): Promise<boolean> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select({ id: zapiInstances.messagingProviderInstanceId })
      .from(zapiInstances)
      .where(eq(zapiInstances.zapiInstanceId, zapiInstanceId))
      .limit(1);

    return Boolean(row);
  }

  async insertZApiInstance(
    base: NewMessagingProviderInstance,
    zapi: Omit<NewZApiInstance, "messagingProviderInstanceId">,
    tx: DbOrTx
  ): Promise<{ id: string }> {
    const [inserted] = await tx.insert(messagingProviderInstances).values(base).returning({
      id: messagingProviderInstances.id,
    });

    if (!inserted) {
      throw new Error("Falha ao inserir messaging_provider_instances");
    }

    await tx.insert(zapiInstances).values({
      ...zapi,
      messagingProviderInstanceId: inserted.id,
    });

    return inserted;
  }

  async setEnabled(id: string, isEnabled: boolean): Promise<MessagingProviderInstance | null> {
    const [updated] = await this.db
      .update(messagingProviderInstances)
      .set({ isEnabled, updatedAt: new Date() })
      .where(eq(messagingProviderInstances.id, id))
      .returning();

    return updated ?? null;
  }

  // Callers garantem que ao menos um campo do patch é `!== undefined` — não
  // precisamos do branch no-op.
  async updateBase(
    id: string,
    patch: UpdateBasePatch,
    tx?: DbOrTx
  ): Promise<MessagingProviderInstance | null> {
    const executor = tx ?? this.db;

    const [updated] = await executor
      .update(messagingProviderInstances)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(messagingProviderInstances.id, id))
      .returning();

    return updated ?? null;
  }

  async updateZApiCredentials(
    id: string,
    patch: { instanceToken?: string; customClientToken?: string | null },
    tx?: DbOrTx
  ): Promise<ZApiInstance | null> {
    const executor = tx ?? this.db;

    const [updated] = await executor
      .update(zapiInstances)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(zapiInstances.messagingProviderInstanceId, id))
      .returning();

    return updated ?? null;
  }

  async updateZApiCurrentStatus(
    id: string,
    snapshot: ZApiCurrentStatusUpdate,
    tx?: DbOrTx
  ): Promise<void> {
    const executor = tx ?? this.db;
    const now = new Date();

    await executor
      .update(zapiInstances)
      .set({
        ...snapshot,
        lastStatusSyncedAt: now,
        lastDeviceSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(zapiInstances.messagingProviderInstanceId, id));
  }

  async insertConnectionEvent(
    providerInstanceId: string,
    event: ConnectionEventInsert,
    tx?: DbOrTx
  ): Promise<void> {
    const executor = tx ?? this.db;
    await executor.insert(zapiInstanceConnectionEvents).values({
      messagingProviderInstanceId: providerInstanceId,
      ...event,
    });
  }

  async insertDeviceSnapshot(
    providerInstanceId: string,
    snapshot: DeviceSnapshotInsert,
    tx?: DbOrTx
  ): Promise<void> {
    const executor = tx ?? this.db;
    await executor.insert(zapiInstanceDeviceSnapshots).values({
      messagingProviderInstanceId: providerInstanceId,
      ...snapshot,
    });
  }

  async markUnreachableAndDisable(id: string, reason: string): Promise<void> {
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .update(zapiInstances)
        .set({
          currentConnectionState: "unreachable",
          currentStatusReason: reason,
          currentConnected: false,
          lastStatusSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(zapiInstances.messagingProviderInstanceId, id));

      await tx
        .update(messagingProviderInstances)
        .set({ isEnabled: false, updatedAt: now })
        .where(eq(messagingProviderInstances.id, id));
    });
  }

  async withTransaction<T>(fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx as unknown as DbOrTx));
  }

  private buildFilters(filters: InstanceFilters) {
    const conditions = [isNull(messagingProviderInstances.archivedAt)];

    if (filters.protocol) {
      conditions.push(eq(messagingProviderInstances.protocol, filters.protocol));
    }
    if (filters.providerKind) {
      conditions.push(eq(messagingProviderInstances.providerKind, filters.providerKind));
    }
    if (typeof filters.isEnabled === "boolean") {
      conditions.push(eq(messagingProviderInstances.isEnabled, filters.isEnabled));
    }

    return and(...conditions);
  }
}
