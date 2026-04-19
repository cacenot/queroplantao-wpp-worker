import type { Redis } from "ioredis";
import type { ModerationConfigRepository } from "../../db/repositories/moderation-config-repository.ts";
import { logger } from "../../lib/logger.ts";
import { toModerationConfig } from "./serialize.ts";
import { type ModerationConfig, NotFoundError } from "./types.ts";

type ModerationConfigCacheOptions = {
  redis: Redis;
  repo: ModerationConfigRepository;
  prefix: string;
  /** TTL em segundos. Safety net caso `invalidate()` silenciosamente falhe. */
  ttlSeconds?: number;
};

/**
 * Cache Redis da config de moderação ativa.
 *
 * - `getActive()`: lê do Redis (hit ~1ms), ou cai para Postgres e repopula em miss.
 * - `invalidate()`: após write via service; Redis compartilhado propaga para todos os workers.
 * - TTL 5min: safety net caso o `DEL` silenciosamente falhe (erro transiente Redis, etc.).
 * - Fallback em erro Redis: cai direto no Postgres, sem cachear.
 */
export class ModerationConfigCache {
  private readonly redis: Redis;
  private readonly repo: ModerationConfigRepository;
  private readonly key: string;
  private readonly ttlSeconds: number;

  constructor(options: ModerationConfigCacheOptions) {
    this.redis = options.redis;
    this.repo = options.repo;
    this.key = `${options.prefix}:active`;
    this.ttlSeconds = options.ttlSeconds ?? 300;
  }

  async getActive(): Promise<ModerationConfig> {
    const cached = await this.readCache();
    if (cached) return cached;

    const row = await this.repo.findActive();
    if (!row) {
      throw new NotFoundError("Nenhuma config de moderação ativa no banco");
    }

    const config = toModerationConfig(row);
    await this.writeCache(config);
    return config;
  }

  async invalidate(): Promise<void> {
    try {
      await this.redis.del(this.key);
    } catch (err) {
      logger.warn({ err }, "Falha ao invalidar cache de moderation-config — TTL vai purgar");
    }
  }

  private async readCache(): Promise<ModerationConfig | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(this.key);
    } catch (err) {
      logger.warn({ err }, "Falha ao ler cache de moderation-config — caindo no Postgres");
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ModerationConfig;
    } catch (err) {
      logger.warn({ err }, "Cache de moderation-config corrompido — caindo no Postgres");
      return null;
    }
  }

  private async writeCache(config: ModerationConfig): Promise<void> {
    try {
      await this.redis.set(this.key, JSON.stringify(config), "EX", this.ttlSeconds);
    } catch (err) {
      logger.warn({ err }, "Falha ao repopular cache de moderation-config — segue sem cache");
    }
  }
}
