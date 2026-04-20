import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { MessagingProviderInstanceRepository } from "../db/repositories/messaging-provider-instance-repository.ts";
import { ModerationConfigRepository } from "../db/repositories/moderation-config-repository.ts";
import { PhonePoliciesRepository } from "../db/repositories/phone-policies-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { GroupMessagesService } from "../services/group-messages/group-messages-service.ts";
import { MessagingGroupsCache } from "../services/messaging-groups/messaging-groups-cache.ts";
import { MessagingProviderInstanceService } from "../services/messaging-provider-instance/index.ts";
import {
  ModerationConfigCache,
  ModerationConfigService,
} from "../services/moderation-config/index.ts";
import { ModerationEnforcementService } from "../services/moderation-enforcement/index.ts";
import { PhonePoliciesService } from "../services/phone-policies/index.ts";
import { TaskService } from "../services/task/index.ts";

export async function buildDeps() {
  // --- Conexões de infraestrutura ---
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const redis = createRedisConnection(env.REDIS_URL);

  const rabbit = createAmqpConnection();
  const publisher = rabbit.createPublisher({ confirm: true, maxAttempts: 2 });

  // --- Repositórios ---
  const taskRepo = new TaskRepository(db);
  const instanceRepo = new MessagingProviderInstanceRepository(db);
  const messagingGroupsRepo = new MessagingGroupsRepository(db);
  const groupMessagesRepo = new GroupMessagesRepository(db);
  const moderationsRepo = new MessageModerationsRepository(db);
  const moderationConfigRepo = new ModerationConfigRepository(db);
  const phonePoliciesRepo = new PhonePoliciesRepository(db);

  // --- Serviços de domínio ---
  const taskService = new TaskService({
    repo: taskRepo,
    publisher,
    queueName: env.AMQP_QUEUE,
  });

  const instanceService = new MessagingProviderInstanceService(instanceRepo);

  const messagingGroupsCache = new MessagingGroupsCache({
    redis,
    repo: messagingGroupsRepo,
    prefix: env.MESSAGING_GROUPS_REDIS_PREFIX,
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

  const phonePoliciesService = new PhonePoliciesService({ repo: phonePoliciesRepo });

  const enforcement = new ModerationEnforcementService({
    phonePoliciesService,
    taskService,
    redis,
    logger,
  });

  const groupMessagesService = new GroupMessagesService({
    groupMessagesRepo,
    moderationsRepo,
    messagingGroupsRepo,
    messagingGroupsCache,
    taskService,
    moderationConfigService,
    enforcement,
    ingestionDedupeWindowMs: env.INGESTION_DEDUPE_WINDOW_MS,
    moderationReuseWindowMs: env.MODERATION_REUSE_WINDOW_MS,
  });

  return {
    sql,
    redis,
    rabbit,
    publisher,
    taskService,
    instanceService,
    moderationConfigService,
    phonePoliciesService,
    groupMessagesService,
  };
}

export type ApiDeps = Awaited<ReturnType<typeof buildDeps>>;
