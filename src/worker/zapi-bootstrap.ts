import type { Redis } from "ioredis";
import { env } from "../config/env.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../lib/logger.ts";
import { ProviderGateway } from "../messaging/gateway.ts";
import { ProviderGatewayRegistry } from "../messaging/gateway-registry.ts";
import type { MessagingProviderExecution } from "../messaging/types.ts";
import type { WhatsAppProvider } from "../messaging/whatsapp/types.ts";
import { ZApiClient } from "../messaging/whatsapp/zapi/client.ts";
import type { ZApiInstanceConfig } from "../messaging/whatsapp/zapi/types.ts";
import { ProviderRegistryReadService } from "../services/provider-registry/provider-registry-read-service.ts";
import type { ZApiProviderRegistryRow } from "../services/provider-registry/zod.ts";

function mapExecutionStrategy(instance: {
  executionStrategy: "leased" | "passthrough";
  safetyTtlMs: number | null;
  heartbeatIntervalMs: number | null;
}): MessagingProviderExecution {
  if (instance.executionStrategy === "passthrough") {
    return { kind: "passthrough" };
  }

  return {
    kind: "leased",
    safetyTtlMs: instance.safetyTtlMs ?? undefined,
    heartbeatIntervalMs: instance.heartbeatIntervalMs ?? undefined,
  };
}

function rowToZApiConfig(row: ZApiProviderRegistryRow): ZApiInstanceConfig {
  return {
    providerInstanceId: row.providerId,
    instance_id: row.instanceId,
    instance_token: row.instanceToken,
    client_token: env.ZAPI_CLIENT_TOKEN,
    execution: mapExecutionStrategy(row),
  };
}

export async function loadZApiProviderRows(db: Db): Promise<ZApiProviderRegistryRow[]> {
  const registry = new ProviderRegistryReadService(db);
  const instances = await registry.listEnabledZApiInstances();

  if (instances.length === 0) {
    throw new Error("Nenhuma instância Z-API habilitada encontrada no banco");
  }

  logger.info({ count: instances.length }, "Instâncias Z-API carregadas do banco");

  return instances;
}

export async function buildWhatsappGatewayRegistry(
  redis: Redis,
  rows: ZApiProviderRegistryRow[]
): Promise<ProviderGatewayRegistry<WhatsAppProvider>> {
  const groups = new Map<string, ZApiProviderRegistryRow[]>();
  for (const row of rows) {
    const group = groups.get(row.redisKey) ?? [];
    group.push(row);
    groups.set(row.redisKey, group);
  }

  const registry = new ProviderGatewayRegistry<WhatsAppProvider>();

  for (const [redisKey, groupRows] of groups) {
    const providers = groupRows.map((row) => new ZApiClient(rowToZApiConfig(row)));
    const gateway = new ProviderGateway<WhatsAppProvider>({
      redis,
      providers,
      delayMinMs: env.ZAPI_DELAY_MIN_MS,
      delayMaxMs: env.ZAPI_DELAY_MAX_MS,
      redisKey,
    });

    await gateway.registerProviders();

    for (const row of groupRows) {
      registry.register(row.providerId, gateway);
    }
  }

  return registry;
}
