import { createModel } from "../ai/model.ts";
import { classifyMessage } from "../ai/moderator.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { declareRetryTopology } from "../lib/retry-topology.ts";
import { GroupSyncService, MessagingGroupsCache } from "../services/messaging-groups/index.ts";
import { TaskService } from "../services/task/index.ts";
import { buildWhatsappGatewayRegistry, loadZApiProviderRows } from "./zapi-bootstrap.ts";

export async function buildDeps() {
  // --- Conexões de infraestrutura ---
  const redis = createRedisConnection(env.REDIS_URL);
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);

  const rabbit = createAmqpConnection();
  const topology = await declareRetryTopology(rabbit);
  const retryPublisher = rabbit.createPublisher({ confirm: true, maxAttempts: 2 });

  // --- Gateway WhatsApp ---
  const zapiRows = await loadZApiProviderRows(db);
  const whatsappGatewayRegistry = await buildWhatsappGatewayRegistry(redis, zapiRows);

  // --- Serviços de domínio ---
  const analyzeMessageModel = createModel(env.AI_MODEL_ANALYZE_MESSAGE);
  const adminApi = new QpAdminApiClient(env.QP_ADMIN_API_URL, env.QP_ADMIN_API_TOKEN);

  const taskService = new TaskService({
    repo: new TaskRepository(db),
    publisher: retryPublisher,
    queueName: env.AMQP_QUEUE,
  });

  const messagingGroupsRepo = new MessagingGroupsRepository(db);
  const moderationsRepo = new MessageModerationsRepository(db);
  const groupMessagesRepo = new GroupMessagesRepository(db);

  // --- Cache e sincronização de grupos monitorados ---
  const messagingGroupsCache = new MessagingGroupsCache({
    redis,
    repo: messagingGroupsRepo,
    prefix: env.MESSAGING_GROUPS_REDIS_PREFIX,
  });

  const groupSyncService = new GroupSyncService({
    adminApi,
    repo: messagingGroupsRepo,
    cache: messagingGroupsCache,
  });

  await groupSyncService.syncFromAdminApi();

  const groupSyncInterval = setInterval(() => {
    groupSyncService.syncFromAdminApi().catch((err) => {
      logger.error({ err }, "Erro em ciclo de sync de grupos monitorados");
    });
  }, env.GROUPS_SYNC_INTERVAL_MS);
  groupSyncInterval.unref?.();

  return {
    redis,
    sql,
    rabbit,
    topology,
    retryPublisher,
    whatsappGatewayRegistry,
    adminApi,
    taskService,
    moderationsRepo,
    groupMessagesRepo,
    groupSyncInterval,
    classifyMessage: (text: string) => classifyMessage(text, analyzeMessageModel),
  };
}

export type WorkerDeps = Awaited<ReturnType<typeof buildDeps>>;
