import { createModel } from "../ai/model.ts";
import { classifyMessage } from "../ai/moderator.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { declareRetryTopology } from "../lib/retry-topology.ts";
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
  const adminApi = new QpAdminApiClient(
    env.QP_ADMIN_API_URL,
    env.QP_ADMIN_API_TOKEN,
    env.QP_ADMIN_API_SERVICE_TOKEN
  );

  const taskService = new TaskService({
    repo: new TaskRepository(db),
    publisher: retryPublisher,
    queueName: env.AMQP_QUEUE,
  });

  const moderationsRepo = new MessageModerationsRepository(db);
  const groupMessagesRepo = new GroupMessagesRepository(db);

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
    classifyMessage: (text: string) => classifyMessage(text, analyzeMessageModel),
  };
}

export type WorkerDeps = Awaited<ReturnType<typeof buildDeps>>;
