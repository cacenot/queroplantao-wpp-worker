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
  listVersionsByPrefix: ReturnType<typeof mock>;
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
    listVersionsByPrefix: mock(async (_prefix: string) => [] as string[]),
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

  describe("nextVersion", () => {
    it("retorna v1 quando não há versões no mês", async () => {
      const svc = new ModerationConfigService({ repo: makeRepo(), cache: makeCache() });
      const v = await svc.nextVersion(new Date("2026-04-15T10:00:00Z"));
      expect(v).toBe("2026-04-v1");
    });

    it("incrementa sobre o maior sufixo numérico existente", async () => {
      const repo = makeRepo({
        listVersionsByPrefix: mock(async () => [
          "2026-04-v1",
          "2026-04-v2",
          "2026-04-v5",
          "2026-04-v3",
        ]),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });
      const v = await svc.nextVersion(new Date("2026-04-15T10:00:00Z"));
      expect(v).toBe("2026-04-v6");
    });

    it("ignora sufixos não-numéricos no cálculo", async () => {
      const repo = makeRepo({
        listVersionsByPrefix: mock(async () => [
          "2026-04-v1",
          "2026-04-v2-rollback",
          "2026-04-v3-hotfix",
        ]),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });
      const v = await svc.nextVersion(new Date("2026-04-15T10:00:00Z"));
      expect(v).toBe("2026-04-v2");
    });

    it("formata mês com zero-pad", async () => {
      const svc = new ModerationConfigService({ repo: makeRepo(), cache: makeCache() });
      const v = await svc.nextVersion(new Date("2026-01-05T10:00:00Z"));
      expect(v).toMatch(/^2026-01-v1$/);
    });

    it("consulta o prefixo do mês corrente", async () => {
      const listSpy = mock(async (_prefix: string) => [] as string[]);
      const repo = makeRepo({ listVersionsByPrefix: listSpy });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });
      await svc.nextVersion(new Date("2026-07-20T10:00:00Z"));
      expect(listSpy).toHaveBeenCalledWith("2026-07-v");
    });
  });

  describe("createConfig — version auto-gerada", () => {
    it("usa nextVersion() quando version é omitida", async () => {
      const repo = makeRepo({
        listVersionsByPrefix: mock(async () => ["2026-04-v1"]),
        insertAndActivate: mock(async (row) => makeRow({ ...row, isActive: true })),
      });
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      const result = await svc.createConfig({
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
      });

      // Sufixo é sempre `yyyy-mm-v{N}` — não travamos no mês atual real.
      expect(result.version).toMatch(/^\d{4}-\d{2}-v\d+$/);
    });

    it("respeita version explícita quando fornecida", async () => {
      const repo = makeRepo();
      const svc = new ModerationConfigService({ repo, cache: makeCache() });

      const result = await svc.createConfig({
        version: "custom-v42",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "sys",
      });

      expect(result.version).toBe("custom-v42");
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
