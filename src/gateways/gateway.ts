import type Redis from "ioredis";
import { logger } from "../lib/logger.ts";
import type { MessagingProvider, MessagingProviderExecution, ProviderExecutor } from "./types.ts";

const ACQUIRE_LEASE_SCRIPT = `
-- provider-gateway:acquire-lease
local availability_key = KEYS[1]
local owner_key = KEYS[2]
local provider_id = ARGV[1]
local owner_token = ARGV[2]
local safety_ttl_ms = tonumber(ARGV[3])

local current_time = redis.call('TIME')
local now_ms = tonumber(current_time[1]) * 1000 + math.floor(tonumber(current_time[2]) / 1000)

local score = redis.call('ZSCORE', availability_key, provider_id)
if not score then
  return nil
end

if tonumber(score) > now_ms then
  return nil
end

local acquired = redis.call('SET', owner_key, owner_token, 'NX', 'PX', safety_ttl_ms)
if acquired ~= 'OK' then
  return nil
end

local lease_until = now_ms + safety_ttl_ms
redis.call('ZADD', availability_key, lease_until, provider_id)
return tostring(lease_until)
`;

const RENEW_LEASE_SCRIPT = `
-- provider-gateway:renew-lease
local availability_key = KEYS[1]
local owner_key = KEYS[2]
local provider_id = ARGV[1]
local owner_token = ARGV[2]
local safety_ttl_ms = tonumber(ARGV[3])

local current_owner = redis.call('GET', owner_key)
if current_owner ~= owner_token then
  return nil
end

local current_time = redis.call('TIME')
local now_ms = tonumber(current_time[1]) * 1000 + math.floor(tonumber(current_time[2]) / 1000)

redis.call('PEXPIRE', owner_key, safety_ttl_ms)

local lease_until = now_ms + safety_ttl_ms
redis.call('ZADD', availability_key, lease_until, provider_id)
return tostring(lease_until)
`;

const RELEASE_LEASE_SCRIPT = `
-- provider-gateway:release-lease
local availability_key = KEYS[1]
local owner_key = KEYS[2]
local provider_id = ARGV[1]
local owner_token = ARGV[2]
local cooldown_ms = tonumber(ARGV[3])

local current_owner = redis.call('GET', owner_key)
if current_owner ~= owner_token then
  return nil
end

local current_time = redis.call('TIME')
local now_ms = tonumber(current_time[1]) * 1000 + math.floor(tonumber(current_time[2]) / 1000)
local available_at = now_ms + cooldown_ms

redis.call('DEL', owner_key)
redis.call('ZADD', availability_key, available_at, provider_id)
return tostring(available_at)
`;

interface ProviderGatewayOptions<T extends MessagingProvider> {
  redis: Redis;
  providers: T[];
  delayMinMs: number;
  delayMaxMs: number;
  redisKey: string;
  acquireTimeoutMs?: number;
  safetyTtlMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

interface LeaseDefaults {
  delayMinMs: number;
  delayMaxMs: number;
  safetyTtlMs: number;
  heartbeatIntervalMs?: number;
}

interface ResolvedLeasedExecution {
  kind: "leased";
  delayMinMs: number;
  delayMaxMs: number;
  safetyTtlMs: number;
  heartbeatIntervalMs: number;
}

type ResolvedProviderExecution = ResolvedLeasedExecution | { kind: "passthrough" };

interface ProviderEntry<T extends MessagingProvider> {
  provider: T;
  execution: ResolvedProviderExecution;
  ownerKey: string;
}

interface ProviderPermit<T extends MessagingProvider> {
  provider: T;
  release(): Promise<void>;
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveHeartbeatInterval(safetyTtlMs: number): number {
  return Math.max(1, Math.floor(safetyTtlMs / 3));
}

function validateCooldownRange(delayMinMs: number, delayMaxMs: number, context: string): void {
  if (delayMinMs < 0 || delayMaxMs < 0) {
    throw new Error(`${context}: delayMinMs e delayMaxMs devem ser >= 0`);
  }

  if (delayMinMs > delayMaxMs) {
    throw new Error(`${context}: delayMinMs não pode ser maior que delayMaxMs`);
  }
}

function resolveProviderExecution(
  execution: MessagingProviderExecution | undefined,
  defaults: LeaseDefaults
): ResolvedProviderExecution {
  if (execution?.kind === "passthrough") {
    return { kind: "passthrough" };
  }

  return {
    kind: "leased",
    delayMinMs: defaults.delayMinMs,
    delayMaxMs: defaults.delayMaxMs,
    safetyTtlMs: defaults.safetyTtlMs,
    heartbeatIntervalMs:
      defaults.heartbeatIntervalMs ?? deriveHeartbeatInterval(defaults.safetyTtlMs),
  };
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
  private readonly providerOrder: ProviderEntry<T>[];
  private readonly redisKey: string;
  private readonly acquireTimeoutMs: number;
  private readonly safetyTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private nextProviderIndex = 0;

  constructor(options: ProviderGatewayOptions<T>) {
    const {
      redis,
      providers,
      delayMinMs,
      delayMaxMs,
      redisKey,
      acquireTimeoutMs = 30_000,
      safetyTtlMs = 30_000,
      heartbeatIntervalMs,
      pollIntervalMs = 100,
    } = options;

    // — 1. Validar opções do gateway
    if (providers.length === 0) {
      throw new Error(`Nenhum provider configurado para ${redisKey}`);
    }

    validateCooldownRange(delayMinMs, delayMaxMs, `Gateway ${redisKey}`);

    if (acquireTimeoutMs <= 0) {
      throw new Error(`Gateway ${redisKey}: acquireTimeoutMs deve ser > 0`);
    }

    if (pollIntervalMs <= 0) {
      throw new Error(`Gateway ${redisKey}: pollIntervalMs deve ser > 0`);
    }

    if (safetyTtlMs <= 0) {
      throw new Error(`Gateway ${redisKey}: safetyTtlMs deve ser > 0`);
    }

    const defaultHeartbeatIntervalMs = heartbeatIntervalMs ?? deriveHeartbeatInterval(safetyTtlMs);

    if (defaultHeartbeatIntervalMs <= 0 || defaultHeartbeatIntervalMs >= safetyTtlMs) {
      throw new Error(
        `Gateway ${redisKey}: heartbeatIntervalMs deve ser > 0 e menor que safetyTtlMs`
      );
    }

    // — 2. Construir entradas de provider com execução resolvida
    const defaults: LeaseDefaults = {
      delayMinMs,
      delayMaxMs,
      safetyTtlMs,
      heartbeatIntervalMs: defaultHeartbeatIntervalMs,
    };

    const providerIds = new Set<string>();
    const providerEntries = providers.map((provider) => {
      const providerId = provider.instance.id;

      if (providerIds.has(providerId)) {
        throw new Error(`Provider duplicado configurado: ${providerId} (redisKey=${redisKey})`);
      }

      providerIds.add(providerId);

      return {
        provider,
        execution: resolveProviderExecution(provider.execution, defaults),
        ownerKey: `${redisKey}:lease:${providerId}`,
      } satisfies ProviderEntry<T>;
    });

    // — 3. Atribuir campos e logar inicialização
    this.redis = redis;
    this.providerOrder = providerEntries;
    this.redisKey = redisKey;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.safetyTtlMs = safetyTtlMs;
    this.heartbeatIntervalMs = defaultHeartbeatIntervalMs;
    this.pollIntervalMs = pollIntervalMs;

    const leasedProviders = providerEntries.filter(
      (entry) => entry.execution.kind === "leased"
    ).length;
    const passthroughProviders = providerEntries.length - leasedProviders;

    logger.info(
      {
        redisKey,
        providers: providerEntries.length,
        leasedProviders,
        passthroughProviders,
        delayMinMs,
        delayMaxMs,
        acquireTimeoutMs,
        safetyTtlMs,
        heartbeatIntervalMs: defaultHeartbeatIntervalMs,
      },
      "ProviderGateway inicializado"
    );
  }

  async registerProviders(): Promise<void> {
    const leasedProviders = this.providerOrder.filter((entry) => entry.execution.kind === "leased");

    if (leasedProviders.length === 0) {
      logger.info(
        { redisKey: this.redisKey },
        "Gateway sem providers leased — registro no Redis ignorado"
      );
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const entry of leasedProviders) {
      pipeline.zadd(this.redisKey, "NX", "0", entry.provider.instance.id);
    }
    await pipeline.exec();

    logger.info(
      { redisKey: this.redisKey, count: leasedProviders.length },
      "Providers registrados no Redis"
    );
  }

  async execute<R>(fn: (provider: T) => Promise<R>): Promise<R> {
    const permit = await this.acquirePermit();

    try {
      return await fn(permit.provider);
    } finally {
      await permit.release();
    }
  }

  private async acquirePermit(): Promise<ProviderPermit<T>> {
    const deadline = Date.now() + this.acquireTimeoutMs;

    while (Date.now() < deadline) {
      const permit = await this.tryAcquireFromRotation();

      if (permit) {
        return permit;
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Timeout ao adquirir provider (${this.redisKey}) após ${this.acquireTimeoutMs}ms`
    );
  }

  private async tryAcquireFromRotation(): Promise<ProviderPermit<T> | null> {
    const providerCount = this.providerOrder.length;
    const startIndex = this.nextProviderIndex;

    for (let offset = 0; offset < providerCount; offset++) {
      const index = (startIndex + offset) % providerCount;
      const entry = this.providerOrder[index];

      if (!entry) {
        continue;
      }

      const permit = await this.tryAcquireEntry(entry);

      if (permit) {
        this.nextProviderIndex = (index + 1) % providerCount;
        return permit;
      }
    }

    return null;
  }

  private async tryAcquireEntry(entry: ProviderEntry<T>): Promise<ProviderPermit<T> | null> {
    const execution = entry.execution;

    // — 1. Fast path: provider sem lease não precisa de coordenação Redis
    if (execution.kind === "passthrough") {
      return {
        provider: entry.provider,
        release: async () => {},
      };
    }

    // — 2. Tentar adquirir lease atômica no Redis
    const ownerToken = crypto.randomUUID();
    const acquired = await this.acquireLease(entry, execution, ownerToken);

    if (!acquired) {
      return null;
    }

    // — 3. Iniciar heartbeat e montar permit com release
    const heartbeat = this.startLeaseHeartbeat(entry, execution, ownerToken);

    return {
      provider: entry.provider,
      release: async () => {
        await heartbeat.stop();

        const cooldownMs = randomDelay(execution.delayMinMs, execution.delayMaxMs);
        const released = await this.releaseLease(entry, ownerToken, cooldownMs);

        if (!released) {
          logger.warn(
            { providerId: entry.provider.instance.id, redisKey: this.redisKey },
            "Lease do provider já não pertencia mais a este worker durante release"
          );
        }
      },
    };
  }

  private async acquireLease(
    entry: ProviderEntry<T>,
    execution: ResolvedLeasedExecution,
    ownerToken: string
  ): Promise<boolean> {
    const result = await this.redis.eval(
      ACQUIRE_LEASE_SCRIPT,
      2,
      this.redisKey,
      entry.ownerKey,
      entry.provider.instance.id,
      ownerToken,
      String(execution.safetyTtlMs)
    );

    return result !== null;
  }

  private async renewLease(
    entry: ProviderEntry<T>,
    execution: ResolvedLeasedExecution,
    ownerToken: string
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_LEASE_SCRIPT,
      2,
      this.redisKey,
      entry.ownerKey,
      entry.provider.instance.id,
      ownerToken,
      String(execution.safetyTtlMs)
    );

    return result !== null;
  }

  private async releaseLease(
    entry: ProviderEntry<T>,
    ownerToken: string,
    cooldownMs: number
  ): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_LEASE_SCRIPT,
      2,
      this.redisKey,
      entry.ownerKey,
      entry.provider.instance.id,
      ownerToken,
      String(cooldownMs)
    );

    return result !== null;
  }

  private startLeaseHeartbeat(
    entry: ProviderEntry<T>,
    execution: ResolvedLeasedExecution,
    ownerToken: string
  ): { stop(): Promise<void> } {
    // — 1. Estado mutável do heartbeat
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingRenewal: Promise<void> | null = null;

    // — 2. Callback de renovação periódica
    const schedule = () => {
      if (stopped) {
        return;
      }

      timer = setTimeout(() => {
        pendingRenewal = this.renewLease(entry, execution, ownerToken)
          .then((renewed) => {
            pendingRenewal = null;

            if (stopped) {
              return;
            }

            if (!renewed) {
              stopped = true;
              logger.warn(
                { providerId: entry.provider.instance.id, redisKey: this.redisKey },
                "Lease do provider foi perdida durante heartbeat"
              );
              return;
            }

            schedule();
          })
          .catch((err) => {
            pendingRenewal = null;

            if (stopped) {
              return;
            }

            stopped = true;
            logger.warn(
              { err, providerId: entry.provider.instance.id, redisKey: this.redisKey },
              "Erro ao renovar lease do provider"
            );
          });
      }, execution.heartbeatIntervalMs);
    };

    // — 3. Disparar heartbeat e retornar handle de parada
    schedule();

    return {
      stop: async () => {
        stopped = true;

        if (timer) {
          clearTimeout(timer);
        }

        if (pendingRenewal) {
          await pendingRenewal.catch(() => undefined);
        }
      },
    };
  }
}
