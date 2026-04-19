import { parseArgs } from "node:util";
import { DEFAULT_SYSTEM_PROMPT } from "../ai/moderator.ts";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { ModerationConfigRepository } from "../db/repositories/moderation-config-repository.ts";
import { logger } from "../lib/logger.ts";
import { createRedisConnection } from "../lib/redis.ts";
import {
  ModerationConfigCache,
  ModerationConfigService,
} from "../services/moderation-config/index.ts";

/**
 * Seed idempotente da config inicial de moderação.
 *
 * Uso:
 *   bun run src/scripts/seed-moderation-config.ts
 *   bun run src/scripts/seed-moderation-config.ts --version seed-2026-04-v1
 *   bun run src/scripts/seed-moderation-config.ts --force
 */

const DEFAULT_PRIMARY_MODEL = "openai/gpt-4o-mini";
const DEFAULT_VERSION = "seed-2026-04-v1";

const { values } = parseArgs({
  options: {
    version: { type: "string", short: "v" },
    force: { type: "boolean", short: "f", default: false },
  },
});

const version = values.version ?? DEFAULT_VERSION;

const redis = createRedisConnection(env.REDIS_URL);
const sql = createDbConnection();
const db = createDrizzleDb(sql);

const repo = new ModerationConfigRepository(db);
const cache = new ModerationConfigCache({
  redis,
  repo,
  prefix: env.MODERATION_CONFIG_REDIS_PREFIX,
});
const service = new ModerationConfigService({ repo, cache });

try {
  const existing = await repo.findByVersion(version);
  if (existing && !values.force) {
    logger.info({ version }, "Version já existe — use --force para recriar (novo version)");
    process.exit(0);
  }

  const finalVersion = existing && values.force ? `${version}-${Date.now()}` : version;

  const config = await service.createConfig({
    version: finalVersion,
    primaryModel: DEFAULT_PRIMARY_MODEL,
    escalationModel: null,
    escalationThreshold: null,
    escalationCategories: [],
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    examples: [],
  });

  logger.info(
    { version: config.version, primaryModel: config.primaryModel },
    "Config de moderação semeada e ativada"
  );
} finally {
  redis.disconnect();
  await sql.end();
}
