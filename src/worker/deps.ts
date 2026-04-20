import { classifyTiered } from "../ai/classify-tiered.ts";
import { createModelRegistry } from "../ai/model-registry.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { ModerationConfigRepository } from "../db/repositories/moderation-config-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { declareRetryTopology } from "../lib/retry-topology.ts";
import {
  ModerationConfigCache,
  ModerationConfigService,
} from "../services/moderation-config/index.ts";
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

  // --- Repositórios ---
  const taskRepo = new TaskRepository(db);
  const moderationsRepo = new MessageModerationsRepository(db);
  const groupMessagesRepo = new GroupMessagesRepository(db);
  const moderationConfigRepo = new ModerationConfigRepository(db);

  // --- Serviços de domínio ---
  const taskService = new TaskService({
    repo: taskRepo,
    publisher: retryPublisher,
    queueName: env.AMQP_QUEUE,
  });

  const moderationConfigCache = new ModerationConfigCache({
    redis,
    repo: moderationConfigRepo,
    prefix: env.MODERATION_CONFIG_REDIS_PREFIX,
  });
  const moderationConfigService = new ModerationConfigService({
    repo: moderationConfigRepo,
    cache: moderationConfigCache,
  });

  // Registry memoiza LanguageModel por string. Troca de config via HTTP reusa
  // instâncias já alocadas — só o novo modelo aloca do zero.
  const modelRegistry = createModelRegistry();

  const moderate = async (text: string) => {
    const config = await moderationConfigService.getActive();
    return classifyTiered(text, {
      primaryModel: modelRegistry.getModel(config.primaryModel),
      primaryModelString: config.primaryModel,
      escalationModel: config.escalationModel
        ? modelRegistry.getModel(config.escalationModel)
        : null,
      escalationModelString: config.escalationModel,
      escalationThreshold: config.escalationThreshold,
      escalationCategories: config.escalationCategories,
      systemPrompt: config.systemPrompt,
      examples: config.examples,
    });
  };

  return {
    redis,
    sql,
    rabbit,
    topology,
    retryPublisher,
    whatsappGatewayRegistry,
    taskService,
    moderationsRepo,
    groupMessagesRepo,
    moderate,
  };
}

export type WorkerDeps = Awaited<ReturnType<typeof buildDeps>>;
