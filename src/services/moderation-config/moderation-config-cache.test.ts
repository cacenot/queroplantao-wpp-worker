import { describe, expect, it, mock } from "bun:test";
import type { Redis } from "ioredis";
import type { ModerationConfigRepository } from "../../db/repositories/moderation-config-repository.ts";
import type { ModerationConfigRow } from "../../db/schema/moderation-configs.ts";
import { ModerationConfigCache } from "./moderation-config-cache.ts";
import { NotFoundError } from "./types.ts";

function makeRow(overrides: Partial<ModerationConfigRow> = {}): ModerationConfigRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    version: "v1",
    primaryModel: "openai/gpt-4o-mini",
    escalationModel: null,
    escalationThreshold: null,
    escalationCategories: [],
    systemPrompt: "sys",
    examples: [],
    isActive: true,
    contentHash: "hash",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    activatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    get: mock(async () => null),
    set: mock(async () => "OK"),
    del: mock(async () => 1),
    ...overrides,
  } as unknown as Redis;
}

function makeRepo(row: ModerationConfigRow | null): ModerationConfigRepository {
  return {
    findActive: mock(async () => row),
  } as unknown as ModerationConfigRepository;
}

describe("ModerationConfigCache", () => {
  describe("getActive", () => {
    it("cache miss: lê do repo e popula Redis com TTL", async () => {
      const row = makeRow();
      const redis = makeRedis();
      const repo = makeRepo(row);
      const cache = new ModerationConfigCache({
        redis,
        repo,
        prefix: "mc",
        ttlSeconds: 300,
      });

      const result = await cache.getActive();

      expect(result.version).toBe("v1");
      expect(redis.get).toHaveBeenCalledWith("mc:active");
      expect(redis.set).toHaveBeenCalledWith("mc:active", expect.any(String), "EX", 300);
      expect(repo.findActive).toHaveBeenCalledTimes(1);
    });

    it("cache hit: retorna do Redis sem consultar repo", async () => {
      const row = makeRow();
      const repo = makeRepo(row);
      const redis = makeRedis({
        get: mock(async () =>
          JSON.stringify({
            id: row.id,
            version: row.version,
            primaryModel: row.primaryModel,
            escalationModel: null,
            escalationThreshold: null,
            escalationCategories: [],
            systemPrompt: row.systemPrompt,
            examples: [],
            contentHash: row.contentHash,
            isActive: true,
            activatedAt: row.activatedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          })
        ) as Redis["get"],
      });
      const cache = new ModerationConfigCache({ redis, repo, prefix: "mc" });

      const result = await cache.getActive();

      expect(result.version).toBe("v1");
      expect(repo.findActive).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it("lança NotFoundError quando não há config ativa no DB", async () => {
      const cache = new ModerationConfigCache({
        redis: makeRedis(),
        repo: makeRepo(null),
        prefix: "mc",
      });

      await expect(cache.getActive()).rejects.toThrow(NotFoundError);
    });

    it("Redis down (get throws): cai no Postgres sem cachear", async () => {
      const row = makeRow();
      const repo = makeRepo(row);
      const redis = makeRedis({
        get: mock(async () => {
          throw new Error("connection refused");
        }) as Redis["get"],
        set: mock(async () => "OK") as unknown as Redis["set"],
      });
      const cache = new ModerationConfigCache({ redis, repo, prefix: "mc" });

      const result = await cache.getActive();

      expect(result.version).toBe("v1");
      expect(repo.findActive).toHaveBeenCalledTimes(1);
      // set ainda é tentado (best-effort); o teste separado cobre erro em set
    });

    it("cache JSON corrompido: cai no Postgres", async () => {
      const row = makeRow();
      const repo = makeRepo(row);
      const redis = makeRedis({
        get: mock(async () => "not-json{{") as Redis["get"],
      });
      const cache = new ModerationConfigCache({ redis, repo, prefix: "mc" });

      const result = await cache.getActive();

      expect(result.version).toBe("v1");
      expect(repo.findActive).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidate", () => {
    it("chama DEL na chave correta", async () => {
      const redis = makeRedis();
      const cache = new ModerationConfigCache({ redis, repo: makeRepo(null), prefix: "mc" });

      await cache.invalidate();

      expect(redis.del).toHaveBeenCalledWith("mc:active");
    });

    it("erro em DEL não propaga (TTL vai purgar)", async () => {
      const redis = makeRedis({
        del: mock(async () => {
          throw new Error("redis down");
        }) as Redis["del"],
      });
      const cache = new ModerationConfigCache({ redis, repo: makeRepo(null), prefix: "mc" });

      await expect(cache.invalidate()).resolves.toBeUndefined();
    });
  });
});
