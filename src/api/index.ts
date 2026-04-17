import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { MessagingProviderInstanceRepository } from "../db/repositories/messaging-provider-instance-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { GroupMessagesService } from "../services/group-messages/group-messages-service.ts";
import { GroupSyncService } from "../services/messaging-groups/group-sync-service.ts";
import { MessagingGroupsCache } from "../services/messaging-groups/messaging-groups-cache.ts";
import { MessagingProviderInstanceService } from "../services/messaging-provider-instance/index.ts";
import { TaskService } from "../services/task/index.ts";
import { startHttpServer } from "./server.ts";

async function main() {
  logger.info("Iniciando wpp-api");

  const rabbit = createAmqpConnection();

  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  const publisher = rabbit.createPublisher({
    confirm: true,
    maxAttempts: 2,
  });

  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const redis = createRedisConnection(env.REDIS_URL);

  const taskRepo = new TaskRepository(db);
  const taskService = new TaskService({
    repo: taskRepo,
    publisher,
    queueName: env.AMQP_QUEUE,
  });

  const instanceRepo = new MessagingProviderInstanceRepository(db);
  const instanceService = new MessagingProviderInstanceService(instanceRepo);

  const messagingGroupsRepo = new MessagingGroupsRepository(db);
  const groupMessagesRepo = new GroupMessagesRepository(db);
  const moderationsRepo = new MessageModerationsRepository(db);

  const messagingGroupsCache = new MessagingGroupsCache({
    redis,
    repo: messagingGroupsRepo,
    prefix: env.MESSAGING_GROUPS_REDIS_PREFIX,
  });

  const adminApi = new QpAdminApiClient(env.QP_ADMIN_API_URL, env.QP_ADMIN_API_TOKEN);

  const groupSyncService = new GroupSyncService({
    adminApi,
    repo: messagingGroupsRepo,
    cache: messagingGroupsCache,
  });

  const groupMessagesService = new GroupMessagesService({
    groupMessagesRepo,
    moderationsRepo,
    messagingGroupsRepo,
    messagingGroupsCache,
    taskService,
    moderationVersion: env.MODERATION_VERSION,
    ingestionDedupeWindowMs: env.INGESTION_DEDUPE_WINDOW_MS,
    moderationReuseWindowMs: env.MODERATION_REUSE_WINDOW_MS,
    moderationModelId: env.AI_MODEL_ANALYZE_MESSAGE,
  });

  // Sync inicial de grupos antes de abrir o servidor para requests
  try {
    await groupSyncService.syncFromAdminApi();
    logger.info("Sync inicial de grupos concluído");
  } catch (err) {
    logger.warn({ err }, "Sync inicial de grupos falhou — servidor sobe mesmo assim");
  }

  const syncInterval = setInterval(async () => {
    try {
      await groupSyncService.syncFromAdminApi();
    } catch (err) {
      logger.warn({ err }, "Sync periódico de grupos falhou");
    }
  }, env.GROUPS_SYNC_INTERVAL_MS);
  syncInterval.unref();

  const httpServer = startHttpServer({
    taskService,
    instanceService,
    groupMessagesService,
    providerInstanceRepo: instanceRepo,
    webhookSecret: env.ZAPI_RECEIVED_WEBHOOK_SECRET,
    webhookEnabled: env.ZAPI_RECEIVED_WEBHOOK_ENABLED,
    isHealthy: () => healthy,
  });

  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando api");
    clearInterval(syncInterval);
    try {
      await httpServer.stop();
      await publisher.close();
      await rabbit.close();
      await redis.quit();
      await sql.end({ timeout: 5 });
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info({ port: env.HTTP_PORT }, "wpp-api pronta");
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar a api");
  process.exit(1);
});
