import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

process.env.DATABASE_URL ??= "postgres://postgres:secret@localhost:5432/queroplantao_messaging";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.AMQP_QUEUE ??= "wpp.actions";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY ??= "test-key";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "test-service-token";

const { createTestDb } = await import("../../test-support/db.ts");
const { ModerationConfigRepository } = await import("./moderation-config-repository.ts");

import type { NewModerationConfigRow } from "../schema/moderation-configs.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

function buildRow(overrides: Partial<NewModerationConfigRow> = {}): NewModerationConfigRow {
  return {
    version: overrides.version ?? `v-${Math.random().toString(36).slice(2, 10)}`,
    primaryModel: "openai/gpt-4o-mini",
    escalationModel: null,
    escalationThreshold: null,
    escalationCategories: [],
    systemPrompt: "sistema",
    examples: [],
    contentHash: "hash",
    ...overrides,
  };
}

describe.skipIf(!INTEGRATION)("ModerationConfigRepository (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof ModerationConfigRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new ModerationConfigRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE moderation_configs RESTART IDENTITY CASCADE`;
  });

  describe("insertAndActivate", () => {
    it("insere com is_active=true e activatedAt preenchido", async () => {
      const inserted = await repo.withTransaction((tx) =>
        repo.insertAndActivate(buildRow({ version: "v1" }), tx)
      );

      expect(inserted.isActive).toBe(true);
      expect(inserted.activatedAt).toBeInstanceOf(Date);
      expect(inserted.version).toBe("v1");
    });

    it("desativa a anterior atomicamente ao inserir a nova", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v1" }), tx));
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v2" }), tx));

      const active = await repo.findActive();
      expect(active?.version).toBe("v2");

      const history = await repo.listHistory(10);
      expect(history).toHaveLength(2);
      expect(history.filter((r) => r.isActive)).toHaveLength(1);
    });

    it("lança em version duplicada", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "dup" }), tx));
      await expect(
        repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "dup" }), tx))
      ).rejects.toThrow();
    });
  });

  describe("partial unique index", () => {
    it("rejeita duas rows com is_active=true via INSERT direto", async () => {
      await testDb.sql.unsafe(
        `INSERT INTO moderation_configs (version, primary_model, system_prompt, content_hash, is_active)
         VALUES ('a', 'openai/gpt-4o-mini', 'p', 'h', true)`
      );

      let err: unknown;
      try {
        await testDb.sql.unsafe(
          `INSERT INTO moderation_configs (version, primary_model, system_prompt, content_hash, is_active)
           VALUES ('b', 'openai/gpt-4o-mini', 'p', 'h', true)`
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toMatch(/duplicate|unique|moderation_configs_active_idx/i);
    });

    it("aceita múltiplas rows com is_active=false", async () => {
      await testDb.sql.unsafe(
        `INSERT INTO moderation_configs (version, primary_model, system_prompt, content_hash, is_active)
         VALUES ('a', 'openai/gpt-4o-mini', 'p', 'h', false),
                ('b', 'openai/gpt-4o-mini', 'p', 'h', false)`
      );

      const all = await repo.listHistory(10);
      expect(all).toHaveLength(2);
      expect(all.every((r) => !r.isActive)).toBe(true);
    });
  });

  describe("findActive", () => {
    it("retorna null quando não há ativa", async () => {
      expect(await repo.findActive()).toBeNull();
    });

    it("retorna a única row ativa", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v1" }), tx));
      const active = await repo.findActive();
      expect(active?.version).toBe("v1");
    });
  });

  describe("findByVersion / existsByVersion", () => {
    it("busca por version", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "vx" }), tx));

      const found = await repo.findByVersion("vx");
      expect(found?.version).toBe("vx");

      expect(await repo.existsByVersion("vx")).toBe(true);
      expect(await repo.existsByVersion("missing")).toBe(false);
    });
  });

  describe("listVersionsByPrefix", () => {
    it("retorna apenas versões que começam pelo prefixo", async () => {
      await repo.withTransaction((tx) =>
        repo.insertAndActivate(buildRow({ version: "2026-04-v1" }), tx)
      );
      await repo.withTransaction((tx) =>
        repo.insertAndActivate(buildRow({ version: "2026-04-v2" }), tx)
      );
      await repo.withTransaction((tx) =>
        repo.insertAndActivate(buildRow({ version: "2026-05-v1" }), tx)
      );

      const apr = await repo.listVersionsByPrefix("2026-04-v");
      expect(apr.sort()).toEqual(["2026-04-v1", "2026-04-v2"]);

      const may = await repo.listVersionsByPrefix("2026-05-v");
      expect(may).toEqual(["2026-05-v1"]);

      const jun = await repo.listVersionsByPrefix("2026-06-v");
      expect(jun).toEqual([]);
    });
  });

  describe("listHistory", () => {
    it("ordena por createdAt desc e respeita limit", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "a" }), tx));
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "b" }), tx));
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "c" }), tx));

      const page = await repo.listHistory(2);
      expect(page.map((r) => r.version)).toEqual(["c", "b"]);
    });
  });

  describe("activateByVersion", () => {
    it("flipa is_active e desativa a anterior na mesma transação", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v1" }), tx));
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v2" }), tx));

      const result = await repo.withTransaction((tx) => repo.activateByVersion("v1", tx));

      expect(result?.version).toBe("v1");
      expect(result?.isActive).toBe(true);

      const active = await repo.findActive();
      expect(active?.version).toBe("v1");
    });

    it("retorna null quando a version não existe", async () => {
      const result = await repo.withTransaction((tx) => repo.activateByVersion("nope", tx));
      expect(result).toBeNull();
    });

    it("é idempotente quando a row já está ativa", async () => {
      await repo.withTransaction((tx) => repo.insertAndActivate(buildRow({ version: "v1" }), tx));
      const result = await repo.withTransaction((tx) => repo.activateByVersion("v1", tx));
      expect(result?.isActive).toBe(true);
    });
  });
});
