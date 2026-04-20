import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import { ProviderGateway } from "./gateway.ts";
import type { MessagingProvider, MessagingProviderExecution } from "./types.ts";

const REDIS_KEY = "messaging:whatsapp";

interface TestProvider extends MessagingProvider {
  readonly execution?: MessagingProviderExecution;
}

class FakePipeline {
  private readonly commands: Array<() => number> = [];

  constructor(private readonly redis: FakeRedis) {}

  zadd(key: string, ...args: string[]): FakePipeline {
    this.commands.push(() => this.redis.zaddInternal(key, ...args));
    return this;
  }

  async exec(): Promise<Array<readonly [null, number]>> {
    return this.commands.map((command) => [null, command()] as const);
  }
}

class FakeRedis {
  evalCalls = 0;

  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly ownerTokens = new Map<string, { token: string; expiresAt: number }>();

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<string | null> {
    this.evalCalls += 1;

    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    if (script.includes("provider-gateway:acquire-lease")) {
      return this.acquireLease(keys[0], keys[1], argv[0], argv[1], Number(argv[2]));
    }

    if (script.includes("provider-gateway:renew-lease")) {
      return this.renewLease(keys[0], keys[1], argv[0], argv[1], Number(argv[2]));
    }

    if (script.includes("provider-gateway:release-lease")) {
      return this.releaseLease(keys[0], keys[1], argv[0], argv[1], Number(argv[2]));
    }

    throw new Error("Script Lua desconhecido no teste");
  }

  zaddInternal(key: string, ...args: string[]): number {
    const zset = this.ensureZset(key);
    const [firstArg, secondArg, thirdArg] = args;

    if (firstArg === "NX") {
      if (!secondArg || !thirdArg) {
        throw new Error("zadd NX inválido no teste");
      }

      if (zset.has(thirdArg)) {
        return 0;
      }

      zset.set(thirdArg, Number(secondArg));
      return 1;
    }

    if (!firstArg || !secondArg) {
      throw new Error("zadd inválido no teste");
    }

    zset.set(secondArg, Number(firstArg));
    return 1;
  }

  getScore(key: string, providerId: string): number | undefined {
    return this.zsets.get(key)?.get(providerId);
  }

  getOwnerToken(redisKey: string, providerId: string): string | undefined {
    this.cleanupExpiredOwners();
    return this.ownerTokens.get(this.buildOwnerKey(redisKey, providerId))?.token;
  }

  forceExpireLease(redisKey: string, providerId: string): void {
    this.ownerTokens.delete(this.buildOwnerKey(redisKey, providerId));
    this.ensureZset(redisKey).set(providerId, 0);
  }

  private acquireLease(
    availabilityKey: string | undefined,
    ownerKey: string | undefined,
    providerId: string | undefined,
    ownerToken: string | undefined,
    safetyTtlMs: number
  ): string | null {
    this.cleanupExpiredOwners();

    if (!availabilityKey || !ownerKey || !providerId || !ownerToken) {
      throw new Error("Acquire inválido no teste");
    }

    const zset = this.ensureZset(availabilityKey);
    const score = zset.get(providerId);

    if (score === undefined) {
      return null;
    }

    const now = Date.now();

    if (score > now) {
      return null;
    }

    if (this.ownerTokens.has(ownerKey)) {
      return null;
    }

    const leaseUntil = now + safetyTtlMs;
    this.ownerTokens.set(ownerKey, { token: ownerToken, expiresAt: leaseUntil });
    zset.set(providerId, leaseUntil);
    return String(leaseUntil);
  }

  private renewLease(
    availabilityKey: string | undefined,
    ownerKey: string | undefined,
    providerId: string | undefined,
    ownerToken: string | undefined,
    safetyTtlMs: number
  ): string | null {
    this.cleanupExpiredOwners();

    if (!availabilityKey || !ownerKey || !providerId || !ownerToken) {
      throw new Error("Renew inválido no teste");
    }

    const owner = this.ownerTokens.get(ownerKey);

    if (!owner || owner.token !== ownerToken) {
      return null;
    }

    const now = Date.now();
    const leaseUntil = now + safetyTtlMs;

    owner.expiresAt = leaseUntil;
    this.ensureZset(availabilityKey).set(providerId, leaseUntil);
    return String(leaseUntil);
  }

  private releaseLease(
    availabilityKey: string | undefined,
    ownerKey: string | undefined,
    providerId: string | undefined,
    ownerToken: string | undefined,
    cooldownMs: number
  ): string | null {
    this.cleanupExpiredOwners();

    if (!availabilityKey || !ownerKey || !providerId || !ownerToken) {
      throw new Error("Release inválido no teste");
    }

    const owner = this.ownerTokens.get(ownerKey);

    if (!owner || owner.token !== ownerToken) {
      return null;
    }

    this.ownerTokens.delete(ownerKey);

    const availableAt = Date.now() + cooldownMs;
    this.ensureZset(availabilityKey).set(providerId, availableAt);
    return String(availableAt);
  }

  private buildOwnerKey(redisKey: string, providerId: string): string {
    return `${redisKey}:lease:${providerId}`;
  }

  private ensureZset(key: string): Map<string, number> {
    const existing = this.zsets.get(key);

    if (existing) {
      return existing;
    }

    const created = new Map<string, number>();
    this.zsets.set(key, created);
    return created;
  }

  private cleanupExpiredOwners(): void {
    const now = Date.now();

    for (const [key, owner] of this.ownerTokens.entries()) {
      if (owner.expiresAt <= now) {
        this.ownerTokens.delete(key);
      }
    }
  }
}

function makeProvider(id: string, execution?: MessagingProviderExecution): TestProvider {
  return {
    instance: { id },
    execution,
  };
}

function createGateway(redis: FakeRedis, providers: TestProvider[]): ProviderGateway<TestProvider> {
  return new ProviderGateway({
    redis: redis as unknown as Redis,
    providers,
    delayMinMs: 0,
    delayMaxMs: 0,
    redisKey: REDIS_KEY,
    acquireTimeoutMs: 500,
    safetyTtlMs: 120,
    heartbeatIntervalMs: 40,
    pollIntervalMs: 5,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await sleep(5);
  }

  throw new Error("Timeout aguardando condição de teste");
}

describe("ProviderGateway", () => {
  it("registra apenas providers leased no Redis", async () => {
    const redis = new FakeRedis();
    const gateway = createGateway(redis, [
      makeProvider("leased-1", { kind: "leased" }),
      makeProvider("passthrough-1", { kind: "passthrough" }),
    ]);

    await gateway.registerProviders();

    expect(redis.getScore(REDIS_KEY, "leased-1")).toBe(0);
    expect(redis.getScore(REDIS_KEY, "passthrough-1")).toBeUndefined();
  });

  it("executa provider passthrough sem coordenação via Redis", async () => {
    const redis = new FakeRedis();
    const gateway = createGateway(redis, [makeProvider("passthrough-1", { kind: "passthrough" })]);

    await gateway.registerProviders();

    const result = await gateway.execute(async (provider) => provider.instance.id);

    expect(result).toBe("passthrough-1");
    expect(redis.evalCalls).toBe(0);
  });

  it("rotaciona entre providers leased e passthrough no mesmo gateway", async () => {
    const redis = new FakeRedis();
    const gateway = createGateway(redis, [
      makeProvider("leased-1", { kind: "leased" }),
      makeProvider("passthrough-1", { kind: "passthrough" }),
    ]);

    await gateway.registerProviders();

    const usedProviders: string[] = [];

    for (let index = 0; index < 4; index++) {
      await gateway.execute(async (provider) => {
        usedProviders.push(provider.instance.id);
      });
    }

    expect(usedProviders).toEqual(["leased-1", "passthrough-1", "leased-1", "passthrough-1"]);
  });

  it("renova a lease por heartbeat e evita dupla aquisição em job longo", async () => {
    const redis = new FakeRedis();
    const gateway = new ProviderGateway({
      redis: redis as unknown as Redis,
      providers: [makeProvider("leased-1", { kind: "leased" })],
      delayMinMs: 0,
      delayMaxMs: 0,
      redisKey: REDIS_KEY,
      acquireTimeoutMs: 500,
      safetyTtlMs: 30,
      heartbeatIntervalMs: 10,
      pollIntervalMs: 5,
    });

    await gateway.registerProviders();

    const events: string[] = [];
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    const firstExecution = gateway.execute(async (provider) => {
      events.push(`start:${provider.instance.id}:first`);
      await firstGate;
      events.push(`end:${provider.instance.id}:first`);
    });

    await waitFor(() => events.includes("start:leased-1:first"));

    const secondExecution = gateway.execute(async (provider) => {
      events.push(`start:${provider.instance.id}:second`);
      events.push(`end:${provider.instance.id}:second`);
    });

    await sleep(80);

    expect(events).not.toContain("start:leased-1:second");

    finishFirst();

    await firstExecution;
    await secondExecution;

    expect(events).toEqual([
      "start:leased-1:first",
      "end:leased-1:first",
      "start:leased-1:second",
      "end:leased-1:second",
    ]);
  });

  it("ignora stale release quando a lease já mudou de owner", async () => {
    const redis = new FakeRedis();
    const gateway = new ProviderGateway({
      redis: redis as unknown as Redis,
      providers: [makeProvider("leased-1", { kind: "leased" })],
      delayMinMs: 0,
      delayMaxMs: 0,
      redisKey: REDIS_KEY,
      acquireTimeoutMs: 500,
      safetyTtlMs: 1_000,
      heartbeatIntervalMs: 200,
      pollIntervalMs: 5,
    });

    await gateway.registerProviders();

    const events: string[] = [];
    let finishFirst!: () => void;
    let finishSecond!: () => void;

    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });

    const firstExecution = gateway.execute(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    });

    await waitFor(() => events.includes("first-start"));

    redis.forceExpireLease(REDIS_KEY, "leased-1");

    const secondExecution = gateway.execute(async () => {
      events.push("second-start");
      await secondGate;
      events.push("second-end");
    });

    await waitFor(() => events.includes("second-start"));

    const ownerBeforeStaleRelease = redis.getOwnerToken(REDIS_KEY, "leased-1");
    const scoreBeforeStaleRelease = redis.getScore(REDIS_KEY, "leased-1");

    finishFirst();
    await firstExecution;

    expect(redis.getOwnerToken(REDIS_KEY, "leased-1")).toBe(ownerBeforeStaleRelease);
    expect(redis.getScore(REDIS_KEY, "leased-1")).toBe(scoreBeforeStaleRelease);

    finishSecond();
    await secondExecution;
  });
});
