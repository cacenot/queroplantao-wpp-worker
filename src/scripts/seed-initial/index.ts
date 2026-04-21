import { z } from "zod";
import { env } from "../../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../../db/client.ts";
import { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import { ModerationConfigRepository } from "../../db/repositories/moderation-config-repository.ts";
import { ZApiClient } from "../../gateways/whatsapp/zapi/client.ts";
import { logger } from "../../lib/logger.ts";
import { QpAdminApiClient } from "../../lib/qp-admin-api.ts";
import { createRedisConnection } from "../../lib/redis.ts";
import { GroupSyncService, MessagingGroupsCache } from "../../services/messaging-groups/index.ts";
import {
  ConflictError as InstanceConflictError,
  MessagingProviderInstanceService,
  maskToken,
} from "../../services/messaging-provider-instance/index.ts";
import {
  ModerationConfigCache,
  ModerationConfigService,
  ConflictError as ModerationConflictError,
} from "../../services/moderation-config/index.ts";
import { MODERATION_EXAMPLES } from "./moderation-examples.ts";
import { MODERATION_SYSTEM_PROMPT } from "./moderation-prompt.ts";

/**
 * Seed inicial idempotente para um ambiente novo (inclusive prod).
 *
 * 1. Se SEED_DATA_JSON estiver definida, cria as instâncias Z-API. Caso
 *    contrário, pula esta etapa (instâncias podem ser criadas depois via API).
 * 2. Cria a moderation config inicial com defaults hardcoded (prompt + examples)
 *    — só roda se não há config ativa no DB.
 * 3. Roda o sync de grupos a partir do QP Admin API.
 *
 * Idempotente: duplicados são pulados. Re-rodar é seguro.
 *
 * Uso:
 *   bun run seed-initial
 *   SEED_DATA_JSON='{"instances":[...]}' bun run seed-initial
 */

const REDIS_KEY = "qp:whatsapp";
const MODERATION_PRIMARY_MODEL = "openai/gpt-4o-mini";

const instanceSchema = z.object({
  displayName: z.string().min(1),
  zapiInstanceId: z.string().min(1),
  instanceToken: z.string().min(1),
  customClientToken: z.string().min(1).nullable().optional(),
});

const seedSchema = z.object({
  instances: z.array(instanceSchema).min(1),
});

type SeedData = z.infer<typeof seedSchema>;
type SeedInstance = z.infer<typeof instanceSchema>;

function parseSeedData(raw: string | undefined): SeedData | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SEED_DATA_JSON não é JSON válido: ${(err as Error).message}`);
  }

  const result = seedSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  [${e.path.join(".")}] ${e.message}`)
      .join("\n");
    throw new Error(`SEED_DATA_JSON inválido:\n${formatted}`);
  }

  return result.data;
}

const seedData = parseSeedData(env.SEED_DATA_JSON);

const redis = createRedisConnection(env.REDIS_URL);
const sql = createDbConnection();
const db = createDrizzleDb(sql);

const instanceRepo = new MessagingProviderInstanceRepository(db);
const instanceService = new MessagingProviderInstanceService({
  repo: instanceRepo,
  redis,
  clientFactory: (credentials) =>
    new ZApiClient({
      providerInstanceId: credentials.providerInstanceId,
      instance_id: credentials.zapiInstanceId,
      instance_token: credentials.instanceToken,
      client_token: credentials.customClientToken ?? env.ZAPI_CLIENT_TOKEN,
    }),
});

const moderationRepo = new ModerationConfigRepository(db);
const moderationCache = new ModerationConfigCache({
  redis,
  repo: moderationRepo,
  prefix: env.MODERATION_CONFIG_REDIS_PREFIX,
});
const moderationService = new ModerationConfigService({
  repo: moderationRepo,
  cache: moderationCache,
});

const messagingGroupsRepo = new MessagingGroupsRepository(db);
const messagingGroupsCache = new MessagingGroupsCache({
  redis,
  repo: messagingGroupsRepo,
  prefix: env.MESSAGING_GROUPS_REDIS_PREFIX,
});
const adminApi = new QpAdminApiClient(
  env.QP_ADMIN_API_URL,
  env.QP_ADMIN_API_TOKEN,
  env.QP_ADMIN_API_SERVICE_TOKEN
);
const groupSyncService = new GroupSyncService({
  adminApi,
  repo: messagingGroupsRepo,
  cache: messagingGroupsCache,
});

async function seedInstance(instance: SeedInstance): Promise<void> {
  const baseLog = {
    step: "instances",
    zapiInstanceId: instance.zapiInstanceId,
    displayName: instance.displayName,
    instanceTokenMasked: maskToken(instance.instanceToken),
    customClientTokenMasked: instance.customClientToken
      ? maskToken(instance.customClientToken)
      : null,
  };

  if (await instanceRepo.existsByZapiInstanceId(instance.zapiInstanceId)) {
    logger.info({ ...baseLog, action: "skipped" }, "Instância já existe — pulando");
    return;
  }

  try {
    const view = await instanceService.createZApiInstance({
      displayName: instance.displayName,
      zapiInstanceId: instance.zapiInstanceId,
      instanceToken: instance.instanceToken,
      customClientToken: instance.customClientToken ?? null,
      executionStrategy: "leased",
      redisKey: REDIS_KEY,
    });
    logger.info({ ...baseLog, providerInstanceId: view.id, action: "created" }, "Instância criada");
  } catch (err) {
    if (err instanceof InstanceConflictError) {
      logger.info({ ...baseLog, action: "skipped" }, "Instância criada concorrentemente — pulando");
      return;
    }
    logger.error({ ...baseLog, err }, "Falha ao criar instância — abortando seed");
    throw err;
  }
}

async function seedModeration(): Promise<void> {
  const baseLog = { step: "moderation" };

  const active = await moderationRepo.findActive();
  if (active) {
    logger.info(
      { ...baseLog, existingVersion: active.version, action: "skipped" },
      "Moderation config já ativa — pulando"
    );
    return;
  }

  try {
    const config = await moderationService.createConfig({
      primaryModel: MODERATION_PRIMARY_MODEL,
      systemPrompt: MODERATION_SYSTEM_PROMPT,
      escalationModel: null,
      escalationThreshold: null,
      escalationCategories: [],
      examples: MODERATION_EXAMPLES,
    });
    logger.info(
      { ...baseLog, version: config.version, primaryModel: config.primaryModel, action: "created" },
      "Moderation config criada e ativada"
    );
  } catch (err) {
    if (err instanceof ModerationConflictError) {
      logger.info(
        { ...baseLog, action: "skipped" },
        "Moderation criada concorrentemente — pulando"
      );
      return;
    }
    logger.error({ ...baseLog, err }, "Falha ao criar moderation config — abortando seed");
    throw err;
  }
}

try {
  // — Etapa 1: provider instances (só roda se SEED_DATA_JSON definida; sequencial, fail-fast)
  if (seedData) {
    for (const instance of seedData.instances) {
      await seedInstance(instance);
    }
  } else {
    logger.info(
      { step: "instances", action: "skipped" },
      "SEED_DATA_JSON não definida — pulando provider instances"
    );
  }

  // — Etapa 2: moderation config inicial (defaults hardcoded)
  await seedModeration();

  // — Etapa 3: sync de grupos a partir do QP Admin API
  const result = await groupSyncService.syncFromAdminApi();
  logger.info({ step: "sync-groups", ...result }, "Sync de grupos concluído");

  logger.info("Seed inicial concluído com sucesso");
} finally {
  redis.disconnect();
  await sql.end();
}
