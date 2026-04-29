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
const { MessagingGroupsRepository } = await import("./messaging-groups-repository.ts");

const INTEGRATION = process.env.INTEGRATION === "1";

type SeedGroup = {
  externalId: string;
  protocol?: "whatsapp" | "telegram";
  syncedAt: Date;
  name?: string;
};

describe.skipIf(!INTEGRATION)("MessagingGroupsRepository.listStaleByProtocol", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof MessagingGroupsRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new MessagingGroupsRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE messaging_groups RESTART IDENTITY CASCADE`;
  });

  async function seed(rows: SeedGroup[]) {
    for (const row of rows) {
      await testDb.sql`
        INSERT INTO messaging_groups (external_id, protocol, name, synced_at)
        VALUES (
          ${row.externalId},
          ${row.protocol ?? "whatsapp"}::messaging_protocol,
          ${row.name ?? row.externalId},
          ${row.syncedAt.toISOString()}
        )
      `;
    }
  }

  function hoursAgo(h: number): Date {
    return new Date(Date.now() - h * 3600_000);
  }

  it("retorna apenas grupos com synced_at < cutoff", async () => {
    await seed([
      { externalId: "fresh@g.us", syncedAt: hoursAgo(1) },
      { externalId: "stale-25h@g.us", syncedAt: hoursAgo(25) },
      { externalId: "stale-48h@g.us", syncedAt: hoursAgo(48) },
    ]);

    const stale = await repo.listStaleByProtocol({
      protocol: "whatsapp",
      syncedBefore: hoursAgo(24),
    });

    const ids = stale.map((g) => g.externalId);
    expect(ids).toContain("stale-25h@g.us");
    expect(ids).toContain("stale-48h@g.us");
    expect(ids).not.toContain("fresh@g.us");
    expect(stale).toHaveLength(2);
  });

  it("ignora grupos de outros protocolos", async () => {
    await seed([
      { externalId: "wpp-stale@g.us", protocol: "whatsapp", syncedAt: hoursAgo(48) },
      { externalId: "tg-stale@g.us", protocol: "telegram", syncedAt: hoursAgo(48) },
    ]);

    const stale = await repo.listStaleByProtocol({
      protocol: "whatsapp",
      syncedBefore: hoursAgo(24),
    });

    const ids = stale.map((g) => g.externalId);
    expect(ids).toEqual(["wpp-stale@g.us"]);
  });

  it("aplica limit corretamente", async () => {
    await seed([
      { externalId: "g1@g.us", syncedAt: hoursAgo(48) },
      { externalId: "g2@g.us", syncedAt: hoursAgo(48) },
      { externalId: "g3@g.us", syncedAt: hoursAgo(48) },
      { externalId: "g4@g.us", syncedAt: hoursAgo(48) },
      { externalId: "g5@g.us", syncedAt: hoursAgo(48) },
    ]);

    const stale = await repo.listStaleByProtocol({
      protocol: "whatsapp",
      syncedBefore: hoursAgo(24),
      limit: 2,
    });

    expect(stale).toHaveLength(2);
  });

  it("ordena por synced_at ASC (mais defasado primeiro)", async () => {
    await seed([
      { externalId: "newest-stale@g.us", syncedAt: hoursAgo(25) },
      { externalId: "oldest-stale@g.us", syncedAt: hoursAgo(72) },
      { externalId: "middle-stale@g.us", syncedAt: hoursAgo(48) },
    ]);

    const stale = await repo.listStaleByProtocol({
      protocol: "whatsapp",
      syncedBefore: hoursAgo(24),
    });

    expect(stale.map((g) => g.externalId)).toEqual([
      "oldest-stale@g.us",
      "middle-stale@g.us",
      "newest-stale@g.us",
    ]);
  });

  it("retorna lista vazia quando todos os grupos estão sincronizados", async () => {
    await seed([
      { externalId: "g1@g.us", syncedAt: hoursAgo(1) },
      { externalId: "g2@g.us", syncedAt: hoursAgo(5) },
    ]);

    const stale = await repo.listStaleByProtocol({
      protocol: "whatsapp",
      syncedBefore: hoursAgo(24),
    });

    expect(stale).toEqual([]);
  });
});
