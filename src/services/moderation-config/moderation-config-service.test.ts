import { describe, expect, it, mock } from "bun:test";
import type { ModerationConfigRepository } from "../../db/repositories/moderation-config-repository.ts";
import type { ModerationConfigRow } from "../../db/schema/moderation-configs.ts";
import type { ModerationConfigCache } from "./moderation-config-cache.ts";
import { ModerationConfigService } from "./moderation-config-service.ts";
import { ConflictError, NotFoundError } from "./types.ts";

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
    contentHash: "h1",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    activatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

type FakeRepo = {
  findActive: ReturnType<typeof mock>;
  findByVersion: ReturnType<typeof mock>;
  listHistory: ReturnType<typeof mock>;
  insertAndActivate: ReturnType<typeof mock>;
  activateByVersion: ReturnType<typeof mock>;
  existsByVersion: ReturnType<typeof mock>;
  withTransaction: ReturnType<typeof mock>;
};

function makeRepo(overrides: Partial<FakeRepo> = {}): ModerationConfigRepository {
  const repo: FakeRepo = {
    findActive: mock(async () => null),
    findByVersion: mock(async () => null),
    listHistory: mock(async () => []),
    insertAndActivate: mock(async (row) => makeRow({ ...row, isActive: true })),
    activateByVersion: mock(async (_v: string) => null),
    existsByVersion: mock(async () => false),
    withTransaction: mock(async (fn: (tx: unknown) => unknown) => fn({})),
    ...overrides,
  };
  return repo as unknown as ModerationConfigRepository;
}

function makeCache(): ModerationConfigCache {
  return {
    getActive: mock(async () => ({}) as never),
    invalidate: mock(async () => undefined),
  } as unknown as ModerationConfigCache;
}

describe("ModerationConfigService", () => {
  describe("createConfig", () => {
    it("insere, ativa e invalida o cache", async () => {
      const repo = makeRepo({
        insertAndActivate: mock(async (row) => makeRow({ ...row, isActive: true })),
      });
      const cache = makeCache();
      const svc = new ModerationConfigService({ repo, cache });

      const result = await svc.createConfig({
        version: "v-new",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
      });

      expect(result.version).toBe("v-new");
      expect(result.isActive).toBe(true);
      expect(cache.invalidate).toHaveBeenCalledTimes(1);
    });

    it("lança ConflictError quando version já existe (pré-check)", async () => {
      const repo = makeRepo({
        existsByVersion: mock(async () => true),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      await expect(
        svc.createConfig({
          version: "dup",
          primaryModel: "openai/gpt-4o-mini",
          systemPrompt: "sys",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("lança ConflictError quando DB lança unique violation em version (race)", async () => {
      const repo = makeRepo({
        existsByVersion: mock(async () => false),
        insertAndActivate: mock(async () => {
          throw new Error(
            'duplicate key value violates unique constraint "moderation_configs_version_unique"'
          );
        }),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      await expect(
        svc.createConfig({
          version: "race",
          primaryModel: "openai/gpt-4o-mini",
          systemPrompt: "sys",
        })
      ).rejects.toThrow(ConflictError);
    });

    it("persiste escalationThreshold como string numeric(3,2)", async () => {
      let captured: unknown;
      const repo = makeRepo({
        insertAndActivate: mock(async (row) => {
          captured = row;
          return makeRow({ ...row, isActive: true });
        }),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      await svc.createConfig({
        version: "v",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
        escalationThreshold: 0.7,
      });

      expect((captured as { escalationThreshold: string }).escalationThreshold).toBe("0.70");
    });

    it("compute contentHash determinístico para inputs equivalentes", async () => {
      const captures: string[] = [];
      const repo = makeRepo({
        insertAndActivate: mock(async (row) => {
          captures.push(row.contentHash);
          return makeRow({ ...row });
        }),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      await svc.createConfig({
        version: "a",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
        escalationCategories: ["product_sales", "service_sales"],
      });
      await svc.createConfig({
        version: "b",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
        escalationCategories: ["service_sales", "product_sales"],
      });

      expect(captures[0]).toBe(captures[1] as string);
    });
  });

  describe("activate", () => {
    it("flipa active e invalida cache", async () => {
      const repo = makeRepo({
        activateByVersion: mock(async () => makeRow({ version: "old", isActive: true })),
      });
      const cache = makeCache();
      const svc = new ModerationConfigService({ repo, cache });

      const result = await svc.activate("old");

      expect(result.version).toBe("old");
      expect(cache.invalidate).toHaveBeenCalledTimes(1);
    });

    it("lança NotFoundError quando version não existe", async () => {
      const repo = makeRepo({
        activateByVersion: mock(async () => null),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      await expect(svc.activate("missing")).rejects.toThrow(NotFoundError);
    });
  });

  describe("getActive", () => {
    it("delega ao cache", async () => {
      const cache = makeCache();
      const svc = new ModerationConfigService({ repo: makeRepo(), cache });
      await svc.getActive().catch(() => {});
      expect(cache.getActive).toHaveBeenCalledTimes(1);
    });
  });

  describe("findByVersion", () => {
    it("retorna null quando não existe", async () => {
      const svc = new ModerationConfigService({ repo: makeRepo(), cache: makeCache() });
      expect(await svc.findByVersion("x")).toBeNull();
    });

    it("serializa row quando existe", async () => {
      const repo = makeRepo({
        findByVersion: mock(async () => makeRow({ version: "x" })),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });
      const found = await svc.findByVersion("x");
      expect(found?.version).toBe("x");
    });
  });
});
