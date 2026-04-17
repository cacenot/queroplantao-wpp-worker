import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type MessagingProviderInstance,
  messagingProviderInstances,
  type NewMessagingProviderInstance,
  type NewZApiInstance,
  type ZApiInstance,
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
  safetyTtlMs: number | null;
  heartbeatIntervalMs: number | null;
  instanceId: string;
  instanceToken: string;
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
    return this.db
      .select({
        providerId: messagingProviderInstances.id,
        displayName: messagingProviderInstances.displayName,
        executionStrategy: messagingProviderInstances.executionStrategy,
        redisKey: messagingProviderInstances.redisKey,
        safetyTtlMs: messagingProviderInstances.safetyTtlMs,
        heartbeatIntervalMs: messagingProviderInstances.heartbeatIntervalMs,
        instanceId: zapiInstances.zapiInstanceId,
        instanceToken: zapiInstances.instanceToken,
      })
      .from(messagingProviderInstances)
      .innerJoin(
        zapiInstances,
        eq(zapiInstances.messagingProviderInstanceId, messagingProviderInstances.id)
      )
      .where(
        and(
          eq(messagingProviderInstances.protocol, "whatsapp"),
          eq(messagingProviderInstances.providerKind, "whatsapp_zapi"),
          eq(messagingProviderInstances.isEnabled, true),
          isNull(messagingProviderInstances.archivedAt)
        )
      )
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
