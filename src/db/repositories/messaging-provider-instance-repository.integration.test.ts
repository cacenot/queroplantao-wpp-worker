import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

process.env.DATABASE_URL ??= "postgres://postgres:secret@localhost:5432/queroplantao_messaging";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY ??= "test-key";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "test-service-token";

const { createTestDb } = await import("../../test-support/db.ts");
const { MessagingProviderInstanceRepository } = await import(
  "./messaging-provider-instance-repository.ts"
);

const INTEGRATION = process.env.INTEGRATION === "1";

type SeedRow = {
  displayName: string;
  zapiInstanceId: string;
  isEnabled?: boolean;
  archived?: boolean;
  customClientToken?: string | null;
  redisKey?: string;
};

describe.skipIf(!INTEGRATION)("MessagingProviderInstanceRepository (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof MessagingProviderInstanceRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new MessagingProviderInstanceRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE messaging_provider_instances RESTART IDENTITY CASCADE`;
  });

  async function seed(rows: SeedRow[]): Promise<string[]> {
    const ids: string[] = [];
    for (const row of rows) {
      const inserted = await testDb.sql<{ id: string }[]>`
        INSERT INTO messaging_provider_instances
          (protocol, provider_kind, display_name, is_enabled, redis_key, archived_at)
        VALUES (
          'whatsapp', 'whatsapp_zapi', ${row.displayName},
          ${row.isEnabled ?? true}, ${row.redisKey ?? "qp:whatsapp"},
          ${row.archived ? testDb.sql`now()` : null}
        )
        RETURNING id
      `;
      const id = inserted[0]?.id;
      if (!id) throw new Error("seed: insert messaging_provider_instances retornou vazio");
      await testDb.sql`
        INSERT INTO zapi_instances
          (messaging_provider_instance_id, zapi_instance_id, instance_token, custom_client_token)
        VALUES (
          ${id}, ${row.zapiInstanceId}, ${`tok-${row.zapiInstanceId}`},
          ${row.customClientToken ?? null}
        )
      `;
      ids.push(id);
    }
    return ids;
  }

  describe("listEnabledZApiRows", () => {
    it("retorna só instâncias com is_enabled=true", async () => {
      await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: true },
        { displayName: "beta", zapiInstanceId: "z-beta", isEnabled: false },
        { displayName: "gamma", zapiInstanceId: "z-gamma", isEnabled: true },
      ]);

      const rows = await repo.listEnabledZApiRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.instanceId).sort()).toEqual(["z-alpha", "z-gamma"]);
    });

    it("exclui instâncias arquivadas mesmo se enabled=true", async () => {
      await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: true },
        { displayName: "beta", zapiInstanceId: "z-beta", isEnabled: true, archived: true },
      ]);

      const rows = await repo.listEnabledZApiRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("z-alpha");
    });

    it("retorna lista vazia quando todas as instâncias estão disabled", async () => {
      await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: false },
        { displayName: "beta", zapiInstanceId: "z-beta", isEnabled: false },
      ]);

      const rows = await repo.listEnabledZApiRows();
      expect(rows).toHaveLength(0);
    });
  });

  describe("listAllZApiRows", () => {
    it("inclui instâncias enabled E disabled (suporte a onboarding pré-tráfego)", async () => {
      await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: true },
        { displayName: "beta", zapiInstanceId: "z-beta", isEnabled: false },
        { displayName: "gamma", zapiInstanceId: "z-gamma", isEnabled: true },
      ]);

      const rows = await repo.listAllZApiRows();
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.instanceId).sort()).toEqual(["z-alpha", "z-beta", "z-gamma"]);
    });

    it("continua excluindo instâncias arquivadas", async () => {
      await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: false },
        { displayName: "beta", zapiInstanceId: "z-beta", isEnabled: true, archived: true },
        { displayName: "gamma", zapiInstanceId: "z-gamma", isEnabled: false, archived: true },
      ]);

      const rows = await repo.listAllZApiRows();
      // beta e gamma arquivados — só alpha (disabled, mas não arquivado) sobra.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.instanceId).toBe("z-alpha");
    });

    it("retorna campos esperados (providerId, instanceId, instanceToken, customClientToken)", async () => {
      const [providerId] = await seed([
        {
          displayName: "alpha",
          zapiInstanceId: "z-alpha",
          isEnabled: false,
          customClientToken: "ccc-alpha",
        },
      ]);

      const rows = await repo.listAllZApiRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        providerId,
        instanceId: "z-alpha",
        instanceToken: "tok-z-alpha",
        customClientToken: "ccc-alpha",
        executionStrategy: "leased",
        redisKey: "qp:whatsapp",
        displayName: "alpha",
      });
    });

    it("ordena por displayName ASC, depois zapiInstanceId ASC (determinístico)", async () => {
      await seed([
        { displayName: "charlie", zapiInstanceId: "z-2", isEnabled: false },
        { displayName: "alpha", zapiInstanceId: "z-3", isEnabled: true },
        { displayName: "bravo", zapiInstanceId: "z-1", isEnabled: false },
      ]);

      const rows = await repo.listAllZApiRows();
      expect(rows.map((r) => r.displayName)).toEqual(["alpha", "bravo", "charlie"]);
    });
  });

  describe("contraste entre listAllZApiRows e listEnabledZApiRows", () => {
    it("a diferença é exatamente o conjunto de instâncias disabled (não-arquivadas)", async () => {
      await seed([
        { displayName: "enabled-1", zapiInstanceId: "z-en-1", isEnabled: true },
        { displayName: "enabled-2", zapiInstanceId: "z-en-2", isEnabled: true },
        { displayName: "disabled-1", zapiInstanceId: "z-dis-1", isEnabled: false },
        { displayName: "disabled-2", zapiInstanceId: "z-dis-2", isEnabled: false },
        { displayName: "archived", zapiInstanceId: "z-arc", isEnabled: true, archived: true },
      ]);

      const enabled = await repo.listEnabledZApiRows();
      const all = await repo.listAllZApiRows();

      const enabledIds = new Set(enabled.map((r) => r.instanceId));
      const allIds = new Set(all.map((r) => r.instanceId));
      const onlyInAll = [...allIds].filter((id) => !enabledIds.has(id)).sort();

      expect(onlyInAll).toEqual(["z-dis-1", "z-dis-2"]);
      expect(allIds.has("z-arc")).toBe(false);
      expect(enabledIds.has("z-arc")).toBe(false);
    });
  });

  describe("setEnabled afeta listEnabledZApiRows imediatamente", () => {
    it("disable → some de listEnabled mas continua em listAll", async () => {
      const [id] = await seed([
        { displayName: "alpha", zapiInstanceId: "z-alpha", isEnabled: true },
      ]);
      if (!id) throw new Error("seed sem id");

      const before = await repo.listEnabledZApiRows();
      expect(before).toHaveLength(1);

      await repo.setEnabled(id, false);

      const enabledAfter = await repo.listEnabledZApiRows();
      const allAfter = await repo.listAllZApiRows();
      expect(enabledAfter).toHaveLength(0);
      expect(allAfter).toHaveLength(1);
      expect(allAfter[0]?.instanceId).toBe("z-alpha");
    });
  });
});
