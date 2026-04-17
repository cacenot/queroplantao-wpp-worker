import type { Redis } from "ioredis";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import { logger } from "../../lib/logger.ts";

type Protocol = "whatsapp" | "telegram";

interface MessagingGroupsCacheOptions {
  redis: Redis;
  repo: MessagingGroupsRepository;
  prefix: string;
}

/**
 * Cache de grupos monitorados em Redis com fallback em Postgres.
 * - Lookup: SISMEMBER no set Redis; se 0, consulta o Postgres e repopula o set.
 * - replaceSet: troca atômica via chave versionada + RENAME (reescrita completa).
 */
export class MessagingGroupsCache {
  private readonly redis: Redis;
  private readonly repo: MessagingGroupsRepository;
  private readonly prefix: string;

  constructor(options: MessagingGroupsCacheOptions) {
    this.redis = options.redis;
    this.repo = options.repo;
    this.prefix = options.prefix;
  }

  private setKey(protocol: Protocol): string {
    return `${this.prefix}:${protocol}`;
  }

  private versionedKey(protocol: Protocol, suffix: string): string {
    return `${this.prefix}:${protocol}:${suffix}`;
  }

  async isMonitored(externalId: string, protocol: Protocol): Promise<boolean> {
    try {
      const hit = await this.redis.sismember(this.setKey(protocol), externalId);
      if (hit === 1) return true;
    } catch (err) {
      logger.warn({ err, externalId }, "Falha no SISMEMBER — caindo para fallback Postgres");
    }

    const row = await this.repo.findByExternalId(externalId);
    if (!row || row.protocol !== protocol) return false;

    try {
      await this.redis.sadd(this.setKey(protocol), externalId);
    } catch (err) {
      logger.warn({ err, externalId }, "Falha ao repopular cache Redis após fallback");
    }

    return true;
  }

  async replaceSet(protocol: Protocol, externalIds: string[]): Promise<void> {
    const target = this.setKey(protocol);
    const tmp = this.versionedKey(protocol, `tmp:${Date.now()}`);

    try {
      if (externalIds.length > 0) {
        const pipeline = this.redis.pipeline();
        pipeline.del(tmp);
        const chunks = chunkArray(externalIds, 1000);
        for (const chunk of chunks) {
          pipeline.sadd(tmp, ...chunk);
        }
        pipeline.rename(tmp, target);
        await pipeline.exec();
      } else {
        // Lista vazia: garante que o set corrente fica vazio sem apagar a chave.
        await this.redis.del(target);
      }
    } catch (err) {
      logger.error({ err, protocol }, "Falha ao reescrever set de grupos monitorados no Redis");
      try {
        await this.redis.del(tmp);
      } catch {
        // noop
      }
      throw err;
    }
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
