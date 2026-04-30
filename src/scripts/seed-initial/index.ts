import { z } from "zod";
import { env } from "../../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../../db/client.ts";
import { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import { PhonePoliciesRepository } from "../../db/repositories/phone-policies-repository.ts";
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
import { PhonePoliciesService } from "../../services/phone-policies/index.ts";
import { seedPhonePolicies } from "./phone-policies.ts";

/**
 * Seed inicial idempotente para um ambiente novo (inclusive prod).
 *
 * 1. Se SEED_DATA_JSON estiver definida, cria as instâncias Z-API. Caso
 *    contrário, pula esta etapa (instâncias podem ser criadas depois via API).
 * 2. Roda o sync de grupos a partir do QP Admin API.
 *
 * Moderation config não é mais seedada aqui — prompt/examples vivem em
 * `src/ai/moderation/versions/*.md`, carregados no boot via `loadActive()`.
 *
 * Idempotente: duplicados são pulados. Re-rodar é seguro.
 *
 * Uso:
 *   bun run seed-initial
 *   SEED_DATA_JSON='{"instances":[...]}' bun run seed-initial
 */

const REDIS_KEY = "qp:whatsapp";

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
    const formatted = result.error.issues
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
const phonePoliciesRepo = new PhonePoliciesRepository(db);
const phonePoliciesService = new PhonePoliciesService({ repo: phonePoliciesRepo });

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

  // — Etapa 2: sync de grupos a partir do QP Admin API
  const result = await groupSyncService.syncFromAdminApi();
  logger.info({ step: "sync-groups", ...result }, "Sync de grupos concluído");

  // — Etapa 3: phone_policies (blacklist + bypass via Z-API phone-exists)
  const enabledRows = await instanceRepo.listEnabledZApiRows();
  const firstRow = enabledRows[0];
  if (!firstRow) {
    logger.warn(
      { step: "phone-policies" },
      "Sem Z-API instance ativa — pulando seed de phone_policies"
    );
  } else {
    const zapiClient = new ZApiClient({
      providerInstanceId: firstRow.providerId,
      instance_id: firstRow.instanceId,
      instance_token: firstRow.instanceToken,
      client_token: firstRow.customClientToken ?? env.ZAPI_CLIENT_TOKEN,
    });
    const policiesResult = await seedPhonePolicies(phonePoliciesService, zapiClient, logger);
    logger.info({ step: "phone-policies", ...policiesResult }, "Seed de phone_policies concluído");
  }

  logger.info("Seed inicial concluído com sucesso");
} finally {
  redis.disconnect();
  await sql.end();
}
