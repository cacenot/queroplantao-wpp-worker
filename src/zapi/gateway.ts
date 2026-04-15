import type Redis from "ioredis";
import { logger } from "../lib/logger.ts";
import { ZApiClient } from "../lib/zapi-client.ts";
import type { ZApiInstance } from "./types.ts";

// ---------------------------------------------------------------------------
// Lua scripts — executados atomicamente no Redis
// ---------------------------------------------------------------------------

/**
 * Acquire: seleciona a instância disponível mais antiga (score ≤ now)
 * e marca como busy (score = now + safetyTtlMs).
 *
 * Se nenhuma instância estiver disponível, retorna nil.
 * O safety TTL garante que, se o worker crashar segurando a instância,
 * ela será liberada automaticamente.
 */
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

/**
 * Release: marca a instância como disponível após cooldown.
 * O score é setado para now + cooldownMs, bloqueando tentativas
 * de acquire até o cooldown expirar.
 */
const RELEASE_SCRIPT = `
local key = KEYS[1]
local available_at = tonumber(ARGV[1])
local instance_id = ARGV[2]

redis.call('ZADD', key, available_at, instance_id)
return 1
`;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface ZApiGatewayOptions {
  redis: Redis;
  instances: ZApiInstance[];
  delayMinMs: number;
  delayMaxMs: number;
  /** Tempo máximo (ms) esperando por uma instância disponível (default: 30000) */
  acquireTimeoutMs?: number;
  /** TTL de segurança (ms) — libera instância automaticamente se worker crashar (default: 30000) */
  safetyTtlMs?: number;
  /** Intervalo (ms) entre tentativas de acquire quando nenhuma instância está disponível (default: 100) */
  pollIntervalMs?: number;
}

const REDIS_KEY = "zapi:instances";

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gateway de acesso controlado à Z-API com coordenação distribuída via Redis.
 *
 * Cada instância Z-API = um número de celular de WhatsApp. Precisa simular
 * comportamento humano: uma ação por vez por instância, com delay aleatório
 * entre ações.
 *
 * Usa um Redis Sorted Set como scheduler distribuído:
 * - Members = instance_id
 * - Scores = timestamp (ms) de quando a instância fica disponível
 * - Lua scripts atômicos para acquire/release (sem race conditions entre workers)
 */
export class ZApiGateway {
  private readonly redis: Redis;
  private readonly instanceMap: Map<string, ZApiInstance>;
  private readonly delayMinMs: number;
  private readonly delayMaxMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly safetyTtlMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ZApiGatewayOptions) {
    const {
      redis,
      instances,
      delayMinMs,
      delayMaxMs,
      acquireTimeoutMs = 30_000,
      safetyTtlMs = 30_000,
      pollIntervalMs = 100,
    } = options;

    if (instances.length === 0) {
      throw new Error("Nenhuma instância Z-API configurada");
    }

    this.redis = redis;
    this.instanceMap = new Map(instances.map((i) => [i.instance_id, i]));
    this.delayMinMs = delayMinMs;
    this.delayMaxMs = delayMaxMs;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.safetyTtlMs = safetyTtlMs;
    this.pollIntervalMs = pollIntervalMs;

    logger.info(
      {
        instances: instances.length,
        delayMinMs,
        delayMaxMs,
        acquireTimeoutMs,
        safetyTtlMs,
      },
      "ZApiGateway inicializado"
    );
  }

  /**
   * Registra instâncias no Redis com score 0 (disponível imediatamente).
   * Usa NX para não sobrescrever instâncias já registradas por outro worker.
   * Deve ser chamado no startup.
   */
  async registerInstances(): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const instanceId of this.instanceMap.keys()) {
      pipeline.zadd(REDIS_KEY, "NX", "0", instanceId);
    }
    await pipeline.exec();

    logger.info({ count: this.instanceMap.size }, "Instâncias Z-API registradas no Redis");
  }

  /**
   * Executa uma operação na Z-API com rate limiting distribuído.
   *
   * Fluxo:
   * 1. Acquire: poll Redis até obter uma instância disponível
   * 2. Execute: roda o callback com o ZApiClient da instância
   * 3. Release: marca a instância como disponível após cooldown aleatório
   */
  async execute<T>(fn: (client: ZApiClient) => Promise<T>): Promise<T> {
    const instanceId = await this.acquireInstance();
    const instance = this.instanceMap.get(instanceId);

    if (!instance) {
      throw new Error(`Instância Z-API não encontrada: ${instanceId}`);
    }

    const client = new ZApiClient(instance);

    try {
      return await fn(client);
    } finally {
      const cooldown = randomDelay(this.delayMinMs, this.delayMaxMs);
      await this.releaseInstance(instanceId, cooldown);
    }
  }

  private async acquireInstance(): Promise<string> {
    const deadline = Date.now() + this.acquireTimeoutMs;

    while (Date.now() < deadline) {
      const now = Date.now();
      const result = await this.redis.eval(
        ACQUIRE_SCRIPT,
        1,
        REDIS_KEY,
        String(now),
        String(this.safetyTtlMs)
      );

      if (result !== null) {
        return result as string;
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Timeout ao adquirir instância Z-API após ${this.acquireTimeoutMs}ms`);
  }

  private async releaseInstance(instanceId: string, cooldownMs: number): Promise<void> {
    const availableAt = Date.now() + cooldownMs;
    await this.redis.eval(RELEASE_SCRIPT, 1, REDIS_KEY, String(availableAt), instanceId);
  }
}

/**
 * Contrato mínimo exigido pelas actions.
 * Usar este tipo em vez de ZApiGateway facilita testes (mocks tipados)
 * e respeita o Princípio da Segregação de Interfaces (ISP).
 */
export type ZApiExecutor = Pick<ZApiGateway, "execute">;
