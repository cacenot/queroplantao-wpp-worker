import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { messagingProviderInstances, zapiInstances } from "../../db/schema/index.ts";
import { parseZApiProviderRegistryRows, type ZApiProviderRegistryRow } from "./zod.ts";

export class ProviderRegistryReadService {
  constructor(private readonly db: Db) {}

  async listEnabledZApiInstances(): Promise<ZApiProviderRegistryRow[]> {
    const rows = await this.db
      .select({
        providerId: messagingProviderInstances.id,
        displayName: messagingProviderInstances.displayName,
        executionStrategy: messagingProviderInstances.executionStrategy,
        redisKey: messagingProviderInstances.redisKey,
        cooldownMinMs: messagingProviderInstances.cooldownMinMs,
        cooldownMaxMs: messagingProviderInstances.cooldownMaxMs,
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

    return parseZApiProviderRegistryRows(rows);
  }
}
