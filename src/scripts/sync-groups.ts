import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { logger } from "../lib/logger.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { GroupSyncService, MessagingGroupsCache } from "../services/messaging-groups/index.ts";

const redis = createRedisConnection(env.REDIS_URL);
const sql = createDbConnection();
const db = createDrizzleDb(sql);

const repo = new MessagingGroupsRepository(db);
const cache = new MessagingGroupsCache({ redis, repo, prefix: env.MESSAGING_GROUPS_REDIS_PREFIX });
const adminApi = new QpAdminApiClient(
  env.QP_ADMIN_API_URL,
  env.QP_ADMIN_API_TOKEN,
  env.QP_ADMIN_API_SERVICE_TOKEN
);
const syncService = new GroupSyncService({ adminApi, repo, cache });

try {
  const result = await syncService.syncFromAdminApi();
  logger.info(result, "sync-groups concluído");
} finally {
  redis.disconnect();
  await sql.end();
}
