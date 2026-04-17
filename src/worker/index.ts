import type { Redis } from "ioredis";
import { createModel } from "../ai/model.ts";
import { classifyMessage } from "../ai/moderator.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb, type Db } from "../db/client.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { declareRetryTopology } from "../lib/retry-topology.ts";
import { ProviderGateway } from "../messaging/gateway.ts";
import { ProviderGatewayRegistry } from "../messaging/gateway-registry.ts";
import type { MessagingProviderExecution } from "../messaging/types.ts";
import type { WhatsAppProvider } from "../messaging/whatsapp/types.ts";
import { ZApiClient } from "../messaging/whatsapp/zapi/client.ts";
import type { ZApiInstanceConfig } from "../messaging/whatsapp/zapi/types.ts";
import { ProviderRegistryReadService } from "../services/provider-registry/provider-registry-read-service.ts";
import type { ZApiProviderRegistryRow } from "../services/provider-registry/zod.ts";
import { TaskService } from "../services/task/index.ts";
import { createJobHandler } from "./handler.ts";

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

async function loadZApiProviderRows(db: Db): Promise<ZApiProviderRegistryRow[]> {
  const registry = new ProviderRegistryReadService(db);
  const instances = await registry.listEnabledZApiInstances();

  if (instances.length === 0) {
    throw new Error("Nenhuma instância Z-API habilitada encontrada no banco");
  }

  logger.info({ count: instances.length }, "Instâncias Z-API carregadas do banco");

  return instances;
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

async function buildWhatsappGatewayRegistry(
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

async function main() {
  logger.info("Iniciando wpp-worker");

  const redis = createRedisConnection(env.REDIS_URL);
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const zapiRows = await loadZApiProviderRows(db);
  const whatsappGatewayRegistry = await buildWhatsappGatewayRegistry(redis, zapiRows);

  const rabbit = createAmqpConnection();

  const topology = await declareRetryTopology(rabbit);

  const retryPublisher = rabbit.createPublisher({ confirm: true, maxAttempts: 2 });

  const analyzeMessageModel = createModel(env.AI_MODEL_ANALYZE_MESSAGE);
  const adminApi = new QpAdminApiClient(env.QP_ADMIN_API_URL, env.QP_ADMIN_API_TOKEN);

  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  const taskService = new TaskService({ repo: new TaskRepository(db) });

  const handleMessage = createJobHandler({
    whatsappGatewayRegistry,
    classifyMessage: (text) => classifyMessage(text, analyzeMessageModel),
    adminApi,
    taskService,
    publisher: retryPublisher,
    topology,
    onSuccess: () => {
      healthy = true;
    },
  });

  const consumer = rabbit.createConsumer(
    {
      queue: env.AMQP_QUEUE,
      queueOptions: { durable: true },
      qos: { prefetchCount: env.AMQP_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP");
    healthy = false;
  });

  logger.info({ queue: env.AMQP_QUEUE }, "Worker ativo — aguardando jobs");

  const healthServer = Bun.serve({
    port: env.WORKER_HEALTH_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(
          { status: healthy ? "ok" : "degraded" },
          { status: healthy ? 200 : 503 }
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });

  logger.info({ port: healthServer.port }, "Health check server iniciado");

  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando worker");
    try {
      healthServer.stop();
      await consumer.close();
      await retryPublisher.close();
      await rabbit.close();
      await sql.end();
      redis.disconnect();
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar o worker");
  process.exit(1);
});
