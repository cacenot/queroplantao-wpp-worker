import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

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

const { createTestDb } = await import("../test-support/db.ts");
const { hoursAgo } = await import("../test-support/time.ts");
const { ZApiError } = await import("../gateways/whatsapp/zapi/client.ts");
const { MessagingGroupsRepository } = await import(
  "../db/repositories/messaging-groups-repository.ts"
);
const { MAX_FAILED_GROUPS_BEFORE_ABORT, runSyncGroupParticipants, silentUI } = await import(
  "./sync-group-participants.ts"
);

import type { ZApiGroupMetadata } from "../gateways/whatsapp/zapi/group-metadata-schema.ts";
import type { Args, SyncClient } from "./sync-group-participants.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

const INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

function defaultArgs(overrides: Partial<Args> = {}): Args {
  return {
    instanceId: INSTANCE_ID,
    limit: null,
    groupExternalId: null,
    markMissingAsLeft: false,
    staleHours: 24,
    concurrency: 5,
    ...overrides,
  };
}

function buildSnapshot(participants: Array<{ phone: string; isAdmin?: boolean }>) {
  return {
    participants: participants.map((p) => ({
      phone: p.phone,
      isAdmin: p.isAdmin ?? false,
      isSuperAdmin: false,
    })),
  } satisfies ZApiGroupMetadata;
}

type FakeResponse = ZApiGroupMetadata | Error | (() => Promise<ZApiGroupMetadata>);

function makeFakeClient(responses: Map<string, FakeResponse>): {
  client: SyncClient;
  calls: { groupId: string }[];
} {
  const calls: { groupId: string }[] = [];
  const client: SyncClient = {
    fetchGroupMetadata: mock(async (groupId: string) => {
      calls.push({ groupId });
      const r = responses.get(groupId);
      if (!r) throw new ZApiError(`fake: unmapped ${groupId}`, 404, null);
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r();
      return r;
    }),
  };
  return { client, calls };
}

describe.skipIf(!INTEGRATION)("runSyncGroupParticipants (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE messaging_groups RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
  });

  async function seedGroup(args: { externalId: string; syncedAt: Date; name?: string }) {
    await testDb.sql`
      INSERT INTO messaging_groups (external_id, protocol, name, synced_at)
      VALUES (
        ${args.externalId},
        'whatsapp'::messaging_protocol,
        ${args.name ?? args.externalId},
        ${args.syncedAt.toISOString()}
      )
    `;
  }

  async function seedActiveParticipant(args: { groupExternalId: string; phone: string }) {
    await testDb.sql`
      INSERT INTO group_participants
        (group_external_id, protocol, provider_kind, phone, role, status)
      VALUES (
        ${args.groupExternalId},
        'whatsapp'::messaging_protocol,
        'whatsapp_zapi'::messaging_provider_kind,
        ${args.phone},
        'member'::group_participant_role,
        'active'::group_participant_status
      )
    `;
  }

  it("filtro 24h: pula grupos sincronizados há < 24h", async () => {
    await seedGroup({ externalId: "fresh@g.us", syncedAt: hoursAgo(1) });
    await seedGroup({ externalId: "stale-25h@g.us", syncedAt: hoursAgo(25) });
    await seedGroup({ externalId: "stale-48h@g.us", syncedAt: hoursAgo(48) });

    const responses = new Map<string, FakeResponse>([
      ["stale-25h@g.us", buildSnapshot([{ phone: "5511999990001" }])],
      ["stale-48h@g.us", buildSnapshot([{ phone: "5511999990002" }])],
    ]);
    const { client, calls } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.succeeded).toBe(2);
    expect(summary.failures).toEqual([]);
    expect(summary.totalEligible).toBe(2);

    const fetched = calls.map((c) => c.groupId).sort();
    expect(fetched).toEqual(["stale-25h@g.us", "stale-48h@g.us"]);

    const [fresh] = await testDb.sql<Array<{ external_id: string; synced_at: Date }>>`
      SELECT external_id, synced_at FROM messaging_groups WHERE external_id = 'fresh@g.us'
    `;
    expect(fresh?.synced_at).toBeDefined();
    // synced_at do "fresh" não foi atualizado: continua < 0.5h atrás (não veio agora).
    expect(new Date(fresh?.synced_at ?? 0).getTime()).toBeLessThan(hoursAgo(0.5).getTime());
  });

  it("--group-external-id ignora cutoff (sincroniza grupo recém-sincronizado)", async () => {
    await seedGroup({ externalId: "recent@g.us", syncedAt: hoursAgo(1) });

    const responses = new Map<string, FakeResponse>([
      ["recent@g.us", buildSnapshot([{ phone: "5511999990010" }])],
    ]);
    const { client, calls } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ groupExternalId: "recent@g.us" }),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.succeeded).toBe(1);
    expect(calls).toHaveLength(1);

    const [participants] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM group_participants WHERE group_external_id = 'recent@g.us'
    `;
    expect(participants?.count).toBe("1");
  });

  it("idempotência: re-rodar com mesmo cutoff não chama Z-API e mantém estado", async () => {
    await seedGroup({ externalId: "g1@g.us", syncedAt: hoursAgo(48) });
    await seedGroup({ externalId: "g2@g.us", syncedAt: hoursAgo(48) });

    const responses = new Map<string, FakeResponse>([
      ["g1@g.us", buildSnapshot([{ phone: "5511999990100" }])],
      ["g2@g.us", buildSnapshot([{ phone: "5511999990200" }])],
    ]);
    const { client, calls } = makeFakeClient(responses);

    const first = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs: async () => {},
    });
    expect(first.succeeded).toBe(2);
    expect(calls).toHaveLength(2);

    const callsBefore = calls.length;

    const second = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs: async () => {},
    });
    expect(second.totalEligible).toBe(0);
    expect(second.succeeded).toBe(0);
    // Não houve chamada nova ao client (todos sincronizados < 24h)
    expect(calls).toHaveLength(callsBefore);

    const [participantCount] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM group_participants
    `;
    expect(participantCount?.count).toBe("2");
  });

  it("idempotência sem cutoff: re-rodar com staleHours=0 não duplica participantes", async () => {
    await seedGroup({ externalId: "g1@g.us", syncedAt: hoursAgo(48) });

    const snapshot = buildSnapshot([{ phone: "5511999990300" }, { phone: "5511999990301" }]);
    const responses = new Map<string, FakeResponse>([["g1@g.us", snapshot]]);
    const { client } = makeFakeClient(responses);

    const first = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ staleHours: 0 }),
      ui: silentUI,
      sleepMs: async () => {},
    });
    expect(first.totalUpserted).toBe(2);

    const second = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ staleHours: 0 }),
      ui: silentUI,
      sleepMs: async () => {},
    });
    expect(second.succeeded).toBe(1);

    const [count] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM group_participants WHERE group_external_id = 'g1@g.us'
    `;
    expect(count?.count).toBe("2");
  });

  it("retenta erros 5xx e sucede na 3ª tentativa", async () => {
    await seedGroup({ externalId: "g1@g.us", syncedAt: hoursAgo(48) });

    let attempts = 0;
    const responses = new Map<string, FakeResponse>([
      [
        "g1@g.us",
        async () => {
          attempts++;
          if (attempts < 3) throw new ZApiError("server err", 503, null);
          return buildSnapshot([{ phone: "5511999990400" }]);
        },
      ],
    ]);
    const { client } = makeFakeClient(responses);

    const sleepMs = mock(async (_ms: number) => {});
    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs,
    });

    expect(summary.succeeded).toBe(1);
    expect(summary.failures).toEqual([]);
    expect(attempts).toBe(3);
    expect(sleepMs).toHaveBeenCalledTimes(2);
  });

  it("grupo que esgota 5 tentativas em 5xx vai para failures, demais continuam", async () => {
    await seedGroup({ externalId: "broken@g.us", syncedAt: hoursAgo(72) });
    await seedGroup({ externalId: "later@g.us", syncedAt: hoursAgo(48) });

    let brokenAttempts = 0;
    const responses = new Map<string, FakeResponse>([
      [
        "broken@g.us",
        async () => {
          brokenAttempts++;
          throw new ZApiError("permanent 503", 503, null);
        },
      ],
      ["later@g.us", buildSnapshot([{ phone: "5511999990500" }])],
    ]);
    const { client } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ concurrency: 1 }),
      ui: silentUI,
      sleepMs: async () => {},
      random: () => 0.5,
    });

    expect(summary.aborted).toBe(false);
    expect(summary.succeeded).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.groupExternalId).toBe("broken@g.us");
    expect(brokenAttempts).toBe(5);

    // broken não atualizou synced_at; later atualizou.
    const [broken] = await testDb.sql<Array<{ synced_at: Date }>>`
      SELECT synced_at FROM messaging_groups WHERE external_id = 'broken@g.us'
    `;
    expect(new Date(broken?.synced_at ?? 0).getTime()).toBeLessThan(hoursAgo(60).getTime());

    const [later] = await testDb.sql<Array<{ synced_at: Date }>>`
      SELECT synced_at FROM messaging_groups WHERE external_id = 'later@g.us'
    `;
    expect(new Date(later?.synced_at ?? 0).getTime()).toBeGreaterThan(hoursAgo(0.5).getTime());
  });

  it("4xx (non-retryable) vai para failures após 1 tentativa, sem abortar", async () => {
    await seedGroup({ externalId: "missing@g.us", syncedAt: hoursAgo(48) });
    await seedGroup({ externalId: "ok@g.us", syncedAt: hoursAgo(48) });

    let missingAttempts = 0;
    const responses = new Map<string, FakeResponse>([
      [
        "missing@g.us",
        async () => {
          missingAttempts++;
          throw new ZApiError("not found", 404, null);
        },
      ],
      ["ok@g.us", buildSnapshot([{ phone: "5511999990900" }])],
    ]);
    const { client } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ concurrency: 1 }),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.aborted).toBe(false);
    expect(summary.succeeded).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.groupExternalId).toBe("missing@g.us");
    expect(missingAttempts).toBe(1);
  });

  it(`aborta quando mais de ${MAX_FAILED_GROUPS_BEFORE_ABORT} grupos falham — provável problema estrutural`, async () => {
    // concurrency=1 → cada grupo processa sequencialmente e checa abort após cada um;
    // o abort dispara exatamente no grupo 26 (failures.length passou de 25 para 26).
    const totalGroups = MAX_FAILED_GROUPS_BEFORE_ABORT + 5;
    for (let i = 0; i < totalGroups; i++) {
      // padding pra ordem estável: i=0 mais defasado (asc por synced_at).
      await seedGroup({
        externalId: `g${String(i).padStart(2, "0")}@g.us`,
        syncedAt: hoursAgo(72 - i),
      });
    }
    const responses = new Map<string, FakeResponse>(
      Array.from({ length: totalGroups }, (_, i) => [
        `g${String(i).padStart(2, "0")}@g.us`,
        new ZApiError("not found", 404, null) as FakeResponse,
      ])
    );
    const { client, calls } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ concurrency: 1 }),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.aborted).toBe(true);
    expect(summary.failures.length).toBe(MAX_FAILED_GROUPS_BEFORE_ABORT + 1); // 26
    // Após aborto, grupos restantes não foram processados.
    expect(calls.length).toBe(MAX_FAILED_GROUPS_BEFORE_ABORT + 1);
    expect(calls.length).toBeLessThan(totalGroups);
    expect(summary.succeeded).toBe(0);
  });

  it("markMissingAsLeft=true marca participantes ausentes do snapshot como left", async () => {
    await seedGroup({ externalId: "g1@g.us", syncedAt: hoursAgo(48) });
    await seedActiveParticipant({ groupExternalId: "g1@g.us", phone: "+5511999990600" });
    await seedActiveParticipant({ groupExternalId: "g1@g.us", phone: "+5511999990601" });
    await seedActiveParticipant({ groupExternalId: "g1@g.us", phone: "+5511999990602" });

    // Snapshot retorna só 2 dos 3 — o terceiro deve virar left.
    const responses = new Map<string, FakeResponse>([
      ["g1@g.us", buildSnapshot([{ phone: "5511999990600" }, { phone: "5511999990601" }])],
    ]);
    const { client } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ markMissingAsLeft: true }),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.totalMarkedLeft).toBe(1);

    const [leftRow] = await testDb.sql<
      Array<{ phone: string; status: string; leave_reason: string | null }>
    >`
      SELECT phone, status, leave_reason
      FROM group_participants
      WHERE group_external_id = 'g1@g.us' AND status = 'left'
    `;
    expect(leftRow?.phone).toBe("+5511999990602");
    expect(leftRow?.leave_reason).toBe("unknown");
  });

  it("markMissingAsLeft=false (default) preserva participantes ausentes como active", async () => {
    await seedGroup({ externalId: "g1@g.us", syncedAt: hoursAgo(48) });
    await seedActiveParticipant({ groupExternalId: "g1@g.us", phone: "+5511999990700" });
    await seedActiveParticipant({ groupExternalId: "g1@g.us", phone: "+5511999990701" });

    const responses = new Map<string, FakeResponse>([
      ["g1@g.us", buildSnapshot([{ phone: "5511999990700" }])],
    ]);
    const { client } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.totalMarkedLeft).toBe(0);

    const [count] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM group_participants
      WHERE group_external_id = 'g1@g.us' AND status = 'active'
    `;
    expect(count?.count).toBe("2");
  });

  it("respeita --limit na query do DB", async () => {
    for (let i = 0; i < 5; i++) {
      await seedGroup({ externalId: `g${i}@g.us`, syncedAt: hoursAgo(48 + i) });
    }
    const responses = new Map<string, FakeResponse>(
      Array.from({ length: 5 }, (_, i) => [
        `g${i}@g.us`,
        buildSnapshot([{ phone: `551199999100${i}` }]),
      ])
    );
    const { client, calls } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ limit: 2 }),
      ui: silentUI,
      sleepMs: async () => {},
    });

    expect(summary.totalEligible).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("paraleliza requests dentro do batch", async () => {
    for (let i = 0; i < 10; i++) {
      await seedGroup({ externalId: `c${i}@g.us`, syncedAt: hoursAgo(48) });
    }

    const slowSnapshot =
      (id: number): FakeResponse =>
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        return buildSnapshot([{ phone: `551199999200${id}` }]);
      };
    const responses = new Map<string, FakeResponse>(
      Array.from({ length: 10 }, (_, i) => [`c${i}@g.us`, slowSnapshot(i)])
    );
    const { client } = makeFakeClient(responses);

    const start = Date.now();
    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs({ concurrency: 5 }),
      ui: silentUI,
      sleepMs: async () => {},
    });
    const elapsed = Date.now() - start;

    expect(summary.succeeded).toBe(10);
    // Sequencial: ~500ms; paralelo concurrency=5: ~100ms + overhead.
    // Margem generosa pra evitar flaky no CI.
    expect(elapsed).toBeLessThan(400);
  });
});

describe.skipIf(!INTEGRATION)("runSyncGroupParticipants — atomicidade por grupo", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let originalUpdateSyncSnapshot: typeof MessagingGroupsRepository.prototype.updateSyncSnapshot;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE messaging_groups RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
    originalUpdateSyncSnapshot = MessagingGroupsRepository.prototype.updateSyncSnapshot;
  });

  afterEach(() => {
    MessagingGroupsRepository.prototype.updateSyncSnapshot = originalUpdateSyncSnapshot;
  });

  it("falha em updateSyncSnapshot faz rollback do applySnapshot na mesma transação", async () => {
    await testDb.sql`
      INSERT INTO messaging_groups (external_id, protocol, name, synced_at)
      VALUES ('g1@g.us', 'whatsapp'::messaging_protocol, 'g1', ${hoursAgo(48).toISOString()})
    `;

    // Monkey-patch: updateSyncSnapshot lança DENTRO da transação após applySnapshot ter rodado.
    // O erro propaga direto (withRetry só envolve o fetch Z-API, não a transação)
    // e o grupo vira uma falha registrada.
    MessagingGroupsRepository.prototype.updateSyncSnapshot = async () => {
      throw new Error("simulated DB failure mid-transaction");
    };

    const responses = new Map<string, FakeResponse>([
      ["g1@g.us", buildSnapshot([{ phone: "5511999990800" }])],
    ]);
    const { client } = makeFakeClient(responses);

    const summary = await runSyncGroupParticipants({
      db: testDb.db,
      client,
      args: defaultArgs(),
      ui: silentUI,
      sleepMs: async () => {},
      random: () => 0.5,
    });

    expect(summary.aborted).toBe(false);
    expect(summary.failures).toHaveLength(1);
    expect((summary.failures[0]?.err as Error).message).toMatch(/simulated DB failure/);

    // Rollback: nenhum participante persistido.
    const [count] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM group_participants WHERE group_external_id = 'g1@g.us'
    `;
    expect(count?.count).toBe("0");
  });
});
