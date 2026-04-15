import type Redis from "ioredis";
import { logger } from "../lib/logger.ts";
import type { MessagingProvider, ProviderExecutor } from "./types.ts";

const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local safety_ttl = tonumber(ARGV[2])

local result = redis.call('ZRANGEBYSCORE', key, '-inf', now, 'LIMIT', 0, 1)
if #result == 0 then
  return nil
end

local instance_id = result[1]
redis.call('ZADD', key, now + safety_ttl, instance_id)
return instance_id
`;

const RELEASE_SCRIPT = `
local key = KEYS[1]
local available_at = tonumber(ARGV[1])
local instance_id = ARGV[2]

redis.call('ZADD', key, available_at, instance_id)
return 1
`;

interface ProviderGatewayOptions<T extends MessagingProvider> {
  redis: Redis;
  providers: T[];
  delayMinMs: number;
  delayMaxMs: number;
  redisKey: string;
  acquireTimeoutMs?: number;
  safetyTtlMs?: number;
  pollIntervalMs?: number;
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gateway genérico com rate limiting distribuído via Redis Sorted Set.
 *
 * Cada provider ocupa uma posição no sorted set indexado pelo redisKey.
 * O score representa quando o provider estará disponível (timestamp ms).
 * Lua scripts atômicos garantem acquire/release sem race conditions entre
 * workers.
 *
 * O rate limit simula comportamento humano: 1 ação por vez por provider,
 * com delay aleatório entre delayMinMs e delayMaxMs após cada uso.
 */
export class ProviderGateway<T extends MessagingProvider> implements ProviderExecutor<T> {
  private readonly redis: Redis;
  private readonly providers: Map<string, T>;
  private readonly delayMinMs: number;
  private readonly delayMaxMs: number;
  private readonly redisKey: string;
  private readonly acquireTimeoutMs: number;
  private readonly safetyTtlMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ProviderGatewayOptions<T>) {
    const {
      redis,
      providers,
      delayMinMs,
      delayMaxMs,
      redisKey,
      acquireTimeoutMs = 30_000,
      safetyTtlMs = 30_000,
      pollIntervalMs = 100,
    } = options;

    if (providers.length === 0) {
      throw new Error(`Nenhum provider configurado para ${redisKey}`);
    }

    this.redis = redis;
    this.providers = new Map(providers.map((p) => [p.instance.id, p]));
    this.delayMinMs = delayMinMs;
    this.delayMaxMs = delayMaxMs;
    this.redisKey = redisKey;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.safetyTtlMs = safetyTtlMs;
    this.pollIntervalMs = pollIntervalMs;

    logger.info(
      {
        redisKey,
        providers: providers.length,
        delayMinMs,
        delayMaxMs,
        acquireTimeoutMs,
        safetyTtlMs,
      },
      "ProviderGateway inicializado"
    );
  }

  async registerProviders(): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const id of this.providers.keys()) {
      pipeline.zadd(this.redisKey, "NX", "0", id);
    }
    await pipeline.exec();

    logger.info(
      { redisKey: this.redisKey, count: this.providers.size },
      "Providers registrados no Redis"
    );
  }

  async execute<R>(fn: (provider: T) => Promise<R>): Promise<R> {
    const id = await this.acquire();
    const provider = this.providers.get(id);

    if (!provider) {
      throw new Error(`Provider não encontrado: ${id} (redisKey=${this.redisKey})`);
    }

    try {
      return await fn(provider);
    } finally {
      const cooldown = randomDelay(this.delayMinMs, this.delayMaxMs);
      await this.release(id, cooldown);
    }
  }

  private async acquire(): Promise<string> {
    const deadline = Date.now() + this.acquireTimeoutMs;

    while (Date.now() < deadline) {
      const now = Date.now();
      const result = await this.redis.eval(
        ACQUIRE_SCRIPT,
        1,
        this.redisKey,
        String(now),
        String(this.safetyTtlMs)
      );

      if (result !== null) {
        return result as string;
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Timeout ao adquirir provider (${this.redisKey}) após ${this.acquireTimeoutMs}ms`
    );
  }

  private async release(id: string, cooldownMs: number): Promise<void> {
    const availableAt = Date.now() + cooldownMs;
    await this.redis.eval(RELEASE_SCRIPT, 1, this.redisKey, String(availableAt), id);
  }
}
