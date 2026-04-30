import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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
const { GroupsReportService } = await import("./groups-report-service.ts");

import type { MessagingProviderInstanceService } from "../messaging-provider-instance/index.ts";
import type { InstanceView } from "../messaging-provider-instance/types.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const INSTANCE_PHONE = "+5511999990001";

function makeInstanceServiceStub(): MessagingProviderInstanceService {
  const view: InstanceView = {
    id: PROVIDER_INSTANCE_ID,
    protocol: "whatsapp",
    providerKind: "whatsapp_zapi",
    displayName: "Test",
    isEnabled: true,
    executionStrategy: "leased",
    redisKey: "messaging:whatsapp",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    zapi: {
      zapiInstanceId: "z",
      instanceTokenMasked: "***",
      customClientTokenMasked: null,
      currentConnectionState: null,
      currentConnected: null,
      currentPhoneNumber: INSTANCE_PHONE,
      lastStatusSyncedAt: null,
    } as InstanceView["zapi"],
  };
  return { get: mock(() => Promise.resolve(view)) } as unknown as MessagingProviderInstanceService;
}

describe.skipIf(!INTEGRATION)("GroupsReportService.buildReport (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let service: InstanceType<typeof GroupsReportService>;

  beforeAll(async () => {
    testDb = await createTestDb();
    service = new GroupsReportService({
      db: testDb.db,
      instanceService: makeInstanceServiceStub(),
    });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE messaging_groups RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
  });

  it("missingGroups vem ordenado por created_at ASC (com id como tiebreaker)", async () => {
    // Insere 3 grupos com created_at intencionalmente fora de ordem cronológica
    // — se a query não tiver ORDER BY explícito, o Postgres devolve em ordem de
    // heap/page (varia com VACUUM/plan) e o teste torna-se um detector real.
    const groups = [
      { externalId: "g-third@g.us", name: "Grupo C", createdAt: "2026-03-15T12:00:00Z" },
      { externalId: "g-first@g.us", name: "Grupo A", createdAt: "2026-01-10T12:00:00Z" },
      { externalId: "g-second@g.us", name: "Grupo B", createdAt: "2026-02-20T12:00:00Z" },
    ];

    for (const g of groups) {
      await testDb.sql`
        INSERT INTO messaging_groups (external_id, protocol, name, invite_url, created_at)
        VALUES (
          ${g.externalId},
          'whatsapp'::messaging_protocol,
          ${g.name},
          ${`https://chat.whatsapp.com/${g.externalId}`},
          ${g.createdAt}
        )
      `;
    }

    // Nenhum participante ativo para a instância → todos os 3 grupos caem em `missingGroups`.

    const out = await service.buildReport(PROVIDER_INSTANCE_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.report.missingFromGroups).toBe(3);
    expect(out.report.missingGroups).toHaveLength(3);

    const names = out.report.missingGroups.map((g) => g.name);
    expect(names).toEqual(["Grupo A", "Grupo B", "Grupo C"]);
  });

  it("ignora grupos onde a instância já está presente (active)", async () => {
    const waId = "5511999990001@s.whatsapp.net";

    await testDb.sql`
      INSERT INTO messaging_groups (external_id, protocol, name, invite_url, created_at)
      VALUES
        ('g-present@g.us', 'whatsapp', 'Presente', 'https://chat.whatsapp.com/P', '2026-01-01T00:00:00Z'),
        ('g-missing@g.us', 'whatsapp', 'Faltando', 'https://chat.whatsapp.com/M', '2026-01-02T00:00:00Z')
    `;

    await testDb.sql`
      INSERT INTO group_participants (
        group_external_id, protocol, provider_kind, wa_id, role, status
      ) VALUES (
        'g-present@g.us', 'whatsapp', 'whatsapp_zapi', ${waId}, 'member', 'active'
      )
    `;

    const out = await service.buildReport(PROVIDER_INSTANCE_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.report.missingGroups).toHaveLength(1);
    expect(out.report.missingGroups[0]?.name).toBe("Faltando");
    expect(out.report.missingFromGroups).toBe(1);
  });

  it("invariante: missingGroups.length === missingFromGroups", async () => {
    // 5 grupos com invite_url, instância em 2 deles → 3 missing.
    const waId = "5511999990001@s.whatsapp.net";

    await testDb.sql`
      INSERT INTO messaging_groups (external_id, protocol, name, invite_url, created_at)
      VALUES
        ('g1@g.us', 'whatsapp', 'G1', 'https://chat.whatsapp.com/1', '2026-01-01T00:00:00Z'),
        ('g2@g.us', 'whatsapp', 'G2', 'https://chat.whatsapp.com/2', '2026-01-02T00:00:00Z'),
        ('g3@g.us', 'whatsapp', 'G3', 'https://chat.whatsapp.com/3', '2026-01-03T00:00:00Z'),
        ('g4@g.us', 'whatsapp', 'G4', 'https://chat.whatsapp.com/4', '2026-01-04T00:00:00Z'),
        ('g5@g.us', 'whatsapp', 'G5', 'https://chat.whatsapp.com/5', '2026-01-05T00:00:00Z')
    `;

    await testDb.sql`
      INSERT INTO group_participants (
        group_external_id, protocol, provider_kind, wa_id, role, status
      ) VALUES
        ('g1@g.us', 'whatsapp', 'whatsapp_zapi', ${waId}, 'member', 'active'),
        ('g3@g.us', 'whatsapp', 'whatsapp_zapi', ${waId}, 'admin',  'active')
    `;

    const out = await service.buildReport(PROVIDER_INSTANCE_ID);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.report.missingGroups.length).toBe(out.report.missingFromGroups);
    expect(out.report.missingGroups.length).toBe(3);
  });
});
