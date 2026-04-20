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
const { PhonePoliciesRepository } = await import("./phone-policies-repository.ts");

import type { NewPhonePolicyRow } from "../schema/phone-policies.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

function buildRow(overrides: Partial<NewPhonePolicyRow> = {}): NewPhonePolicyRow {
  return {
    protocol: "whatsapp",
    kind: "blacklist",
    phone: "5511999990001",
    source: "manual",
    ...overrides,
  };
}

describe.skipIf(!INTEGRATION)("PhonePoliciesRepository (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof PhonePoliciesRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new PhonePoliciesRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE phone_policies RESTART IDENTITY CASCADE`;
  });

  describe("create", () => {
    it("persiste os campos básicos e retorna a row", async () => {
      const row = await repo.create(buildRow({ phone: "5511999990010", reason: "spam repetido" }));

      expect(row.id).toBeString();
      expect(row.protocol).toBe("whatsapp");
      expect(row.kind).toBe("blacklist");
      expect(row.phone).toBe("5511999990010");
      expect(row.reason).toBe("spam repetido");
      expect(row.metadata).toEqual({});
      expect(row.groupExternalId).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("rejeita duplicata (protocol, kind, phone, global)", async () => {
      await repo.create(buildRow({ phone: "5511999990011" }));
      await expect(repo.create(buildRow({ phone: "5511999990011" }))).rejects.toThrow();
    });

    it("rejeita duplicata group-scoped exata", async () => {
      const base = buildRow({ phone: "5511999990012", groupExternalId: "grp-1" });
      await repo.create(base);
      await expect(repo.create(base)).rejects.toThrow();
    });

    it("aceita mesma (phone, kind) com escopos distintos", async () => {
      await repo.create(buildRow({ phone: "5511999990013" }));
      await repo.create(buildRow({ phone: "5511999990013", groupExternalId: "grp-a" }));
      await repo.create(buildRow({ phone: "5511999990013", groupExternalId: "grp-b" }));
      // Sem throw — todas aceitas
    });

    it("aceita mesmo (phone, group) em kinds distintos", async () => {
      await repo.create(buildRow({ phone: "5511999990014", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "5511999990014", kind: "bypass" }));
    });
  });

  describe("findMatch", () => {
    it("retorna null quando não há entry", async () => {
      const match = await repo.findMatch("whatsapp", "blacklist", "5511999990099", "grp-x");
      expect(match).toBeNull();
    });

    it("retorna entry global quando não há group-scoped", async () => {
      const created = await repo.create(buildRow({ phone: "5511999990020" }));
      const match = await repo.findMatch("whatsapp", "blacklist", "5511999990020", "grp-any");
      expect(match?.id).toBe(created.id);
    });

    it("prioriza group-scoped sobre global", async () => {
      await repo.create(buildRow({ phone: "5511999990021" }));
      const scoped = await repo.create(
        buildRow({ phone: "5511999990021", groupExternalId: "grp-x" })
      );

      const match = await repo.findMatch("whatsapp", "blacklist", "5511999990021", "grp-x");
      expect(match?.id).toBe(scoped.id);
    });

    it("ignora entries expiradas", async () => {
      await repo.create(
        buildRow({
          phone: "5511999990022",
          expiresAt: new Date(Date.now() - 1000),
        })
      );

      const match = await repo.findMatch("whatsapp", "blacklist", "5511999990022", "grp-x");
      expect(match).toBeNull();
    });

    it("respeita kind (não mistura blacklist e bypass)", async () => {
      await repo.create(buildRow({ phone: "5511999990023", kind: "blacklist" }));

      const bypass = await repo.findMatch("whatsapp", "bypass", "5511999990023", "grp-x");
      expect(bypass).toBeNull();

      const blacklist = await repo.findMatch("whatsapp", "blacklist", "5511999990023", "grp-x");
      expect(blacklist).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("remove e retorna true", async () => {
      const created = await repo.create(buildRow({ phone: "5511999990030" }));
      const ok = await repo.delete(created.id);
      expect(ok).toBe(true);
      expect(await repo.findById(created.id)).toBeNull();
    });

    it("retorna false quando id não existe", async () => {
      const ok = await repo.delete("00000000-0000-0000-0000-000000000000");
      expect(ok).toBe(false);
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      await repo.create(buildRow({ phone: "5511999990040", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "5511999990041", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "5511999990042", kind: "bypass" }));
      await repo.create(
        buildRow({ phone: "5511999990043", kind: "bypass", groupExternalId: "grp-x" })
      );
    });

    it("filtra por kind", async () => {
      const { rows, total } = await repo.list({ kind: "blacklist" }, { limit: 10, offset: 0 });
      expect(total).toBe(2);
      expect(rows.every((r) => r.kind === "blacklist")).toBe(true);
    });

    it("filtra por phone exato", async () => {
      const { rows, total } = await repo.list({ phone: "5511999990042" }, { limit: 10, offset: 0 });
      expect(total).toBe(1);
      expect(rows[0]?.phone).toBe("5511999990042");
    });

    it("filtra por groupExternalId=null (só globais)", async () => {
      const { total } = await repo.list({ groupExternalId: null }, { limit: 10, offset: 0 });
      expect(total).toBe(3);
    });

    it("filtra por groupExternalId string", async () => {
      const { rows, total } = await repo.list(
        { groupExternalId: "grp-x" },
        { limit: 10, offset: 0 }
      );
      expect(total).toBe(1);
      expect(rows[0]?.groupExternalId).toBe("grp-x");
    });

    it("respeita limit e offset", async () => {
      const first = await repo.list({}, { limit: 2, offset: 0 });
      expect(first.rows).toHaveLength(2);
      expect(first.total).toBe(4);

      const second = await repo.list({}, { limit: 2, offset: 2 });
      expect(second.rows).toHaveLength(2);
      expect(second.total).toBe(4);
    });
  });
});
