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
    phone: "+5511999990001",
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
      const row = await repo.create(buildRow({ phone: "+5511999990010", reason: "spam repetido" }));

      expect(row.id).toBeString();
      expect(row.protocol).toBe("whatsapp");
      expect(row.kind).toBe("blacklist");
      expect(row.phone).toBe("+5511999990010");
      expect(row.reason).toBe("spam repetido");
      expect(row.metadata).toEqual({});
      expect(row.groupExternalId).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it("rejeita duplicata (protocol, kind, phone, global)", async () => {
      await repo.create(buildRow({ phone: "+5511999990011" }));
      await expect(repo.create(buildRow({ phone: "+5511999990011" }))).rejects.toThrow();
    });

    it("rejeita duplicata group-scoped exata", async () => {
      const base = buildRow({ phone: "+5511999990012", groupExternalId: "grp-1" });
      await repo.create(base);
      await expect(repo.create(base)).rejects.toThrow();
    });

    it("aceita mesma (phone, kind) com escopos distintos", async () => {
      await repo.create(buildRow({ phone: "+5511999990013" }));
      await repo.create(buildRow({ phone: "+5511999990013", groupExternalId: "grp-a" }));
      await repo.create(buildRow({ phone: "+5511999990013", groupExternalId: "grp-b" }));
      // Sem throw — todas aceitas
    });

    it("aceita mesmo (phone, group) em kinds distintos", async () => {
      await repo.create(buildRow({ phone: "+5511999990014", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "+5511999990014", kind: "bypass" }));
    });
  });

  describe("findMatch", () => {
    it("retorna null quando não há entry", async () => {
      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990099", senderExternalId: null },
        "grp-x"
      );
      expect(match).toBeNull();
    });

    it("retorna entry global quando não há group-scoped", async () => {
      const created = await repo.create(buildRow({ phone: "+5511999990020" }));
      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990020", senderExternalId: null },
        "grp-any"
      );
      expect(match?.id).toBe(created.id);
    });

    it("prioriza group-scoped sobre global", async () => {
      await repo.create(buildRow({ phone: "+5511999990021" }));
      const scoped = await repo.create(
        buildRow({ phone: "+5511999990021", groupExternalId: "grp-x" })
      );

      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990021", senderExternalId: null },
        "grp-x"
      );
      expect(match?.id).toBe(scoped.id);
    });

    it("ignora entries expiradas", async () => {
      await repo.create(
        buildRow({
          phone: "+5511999990022",
          expiresAt: new Date(Date.now() - 1000),
        })
      );

      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990022", senderExternalId: null },
        "grp-x"
      );
      expect(match).toBeNull();
    });

    it("respeita kind (não mistura blacklist e bypass)", async () => {
      await repo.create(buildRow({ phone: "+5511999990023", kind: "blacklist" }));

      const bypass = await repo.findMatch(
        "whatsapp",
        "bypass",
        { phone: "+5511999990023", senderExternalId: null },
        "grp-x"
      );
      expect(bypass).toBeNull();

      const blacklist = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990023", senderExternalId: null },
        "grp-x"
      );
      expect(blacklist).not.toBeNull();
    });

    it("matcha por sender_external_id (LID)", async () => {
      const created = await repo.create(
        buildRow({ phone: null, senderExternalId: "1234567890@lid" })
      );
      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: null, senderExternalId: "1234567890@lid" },
        "grp-x"
      );
      expect(match?.id).toBe(created.id);
    });

    it("matcha por phone OU LID quando ambos passados", async () => {
      // policy só tem phone
      const byPhone = await repo.create(
        buildRow({ phone: "+5511999990024", senderExternalId: null })
      );
      const matchByPhone = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990024", senderExternalId: "outro@lid" },
        "grp-x"
      );
      expect(matchByPhone?.id).toBe(byPhone.id);
    });

    it("matcha por wa_id quando phone é null", async () => {
      const created = await repo.create(
        buildRow({ phone: null, waId: "554791778115", senderExternalId: "lid-wa@lid" })
      );
      // Lookup só por waId (sem phone e sem LID)
      const matchByWaId = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: null, waId: "554791778115", senderExternalId: null },
        "grp-x"
      );
      expect(matchByWaId?.id).toBe(created.id);
    });

    it("retorna null quando ambos identificadores são null", async () => {
      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: null, senderExternalId: null },
        "grp-x"
      );
      expect(match).toBeNull();
    });

    it("desempata duas policies group-scoped pela mais antiga (createdAt asc)", async () => {
      // policy por phone criada primeiro
      const older = await repo.create(
        buildRow({ phone: "+5511999990050", senderExternalId: null, groupExternalId: "grp-x" })
      );
      // pequena espera pra garantir que a segunda tem createdAt estritamente maior
      await new Promise((r) => setTimeout(r, 10));
      // policy por LID criada depois, mesma chave lógica de match
      await repo.create(
        buildRow({ phone: null, senderExternalId: "lid-50@lid", groupExternalId: "grp-x" })
      );

      const match = await repo.findMatch(
        "whatsapp",
        "blacklist",
        { phone: "+5511999990050", senderExternalId: "lid-50@lid" },
        "grp-x"
      );
      expect(match?.id).toBe(older.id);
    });
  });

  describe("delete", () => {
    it("remove e retorna true", async () => {
      const created = await repo.create(buildRow({ phone: "+5511999990030" }));
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
      await repo.create(buildRow({ phone: "+5511999990040", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "+5511999990041", kind: "blacklist" }));
      await repo.create(buildRow({ phone: "+5511999990042", kind: "bypass" }));
      await repo.create(
        buildRow({ phone: "+5511999990043", kind: "bypass", groupExternalId: "grp-x" })
      );
    });

    it("filtra por kind", async () => {
      const { rows, total } = await repo.list({ kind: "blacklist" }, { limit: 10, offset: 0 });
      expect(total).toBe(2);
      expect(rows.every((r) => r.kind === "blacklist")).toBe(true);
    });

    it("filtra por phone exato", async () => {
      const { rows, total } = await repo.list(
        { phone: "+5511999990042" },
        { limit: 10, offset: 0 }
      );
      expect(total).toBe(1);
      expect(rows[0]?.phone).toBe("+5511999990042");
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
