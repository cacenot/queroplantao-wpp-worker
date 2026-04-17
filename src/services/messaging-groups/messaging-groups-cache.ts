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
 * - Cache negativo (TTL 60s) evita ida ao Postgres para grupos não-monitorados.
 * - replaceSet: troca atômica via chave versionada + RENAME (reescrita completa).
 */
export class MessagingGroupsCache {
  private readonly redis: Redis;
  private readonly repo: MessagingGroupsRepository;
  private readonly prefix: string;
  private readonly negativeTtlS = 60;

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

  private missKey(protocol: Protocol, externalId: string): string {
    return `${this.prefix}:miss:${protocol}:${externalId}`;
  }

  async isMonitored(externalId: string, protocol: Protocol): Promise<boolean> {
    try {
      const hit = await this.redis.sismember(this.setKey(protocol), externalId);
      if (hit === 1) return true;

      // Cache negativo: grupo já confirmado como não-monitorado nesta janela
      const missed = await this.redis.exists(this.missKey(protocol, externalId));
      if (missed === 1) return false;
    } catch (err) {
      logger.warn({ err, externalId }, "Falha no cache Redis — caindo para fallback Postgres");
    }

    const row = await this.repo.findByExternalId(externalId, protocol);
    if (!row) {
      try {
        await this.redis.set(this.missKey(protocol, externalId), "1", "EX", this.negativeTtlS);
      } catch {
        // noop — cache negativo é best-effort
      }
      return false;
    }

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
