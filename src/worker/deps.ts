import { classifyTiered } from "../ai/classify-tiered.ts";
import { createModelRegistry } from "../ai/model-registry.ts";
import { loadActive } from "../ai/moderation/loader.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { PhonePoliciesRepository } from "../db/repositories/phone-policies-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { declareRetryTopology } from "../lib/retry-topology.ts";
import { ModerationEnforcementService } from "../services/moderation-enforcement/index.ts";
import { PhonePoliciesService } from "../services/phone-policies/index.ts";
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
  const phonePoliciesRepo = new PhonePoliciesRepository(db);

  // --- Serviços de domínio ---
  const taskService = new TaskService({
    repo: taskRepo,
    publisher: retryPublisher,
    queueName: env.AMQP_QUEUE,
  });

  const phonePoliciesService = new PhonePoliciesService({ repo: phonePoliciesRepo });
  const enforcement = new ModerationEnforcementService({
    phonePoliciesService,
    taskService,
    redis,
    logger,
  });

  // Config de moderação é arquivo .md versionado em `src/ai/moderation/versions/`.
  // Troca exige redeploy — sem hot-reload (rollback via git revert).
  const moderationConfig = loadActive();

  // Registry memoiza LanguageModel por string.
  const modelRegistry = createModelRegistry();

  const moderate = (text: string) =>
    classifyTiered(text, {
      primaryModel: modelRegistry.getModel(moderationConfig.primaryModel),
      primaryModelString: moderationConfig.primaryModel,
      escalationModel: moderationConfig.escalationModel
        ? modelRegistry.getModel(moderationConfig.escalationModel)
        : null,
      escalationModelString: moderationConfig.escalationModel,
      escalationThreshold: moderationConfig.escalationThreshold,
      escalationCategories: moderationConfig.escalationCategories,
      systemPrompt: moderationConfig.systemPrompt,
      examples: moderationConfig.examples,
    });

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
    enforcement,
  };
}

export type WorkerDeps = Awaited<ReturnType<typeof buildDeps>>;
