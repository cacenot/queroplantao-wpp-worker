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
const { GroupParticipantsRepository } = await import(
  "../../db/repositories/group-participants-repository.ts"
);
const { MessagingGroupsRepository } = await import(
  "../../db/repositories/messaging-groups-repository.ts"
);
const { GroupParticipantsService } = await import("./group-participants-service.ts");

import type { ApplyParticipantEventInput } from "./types.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

const GROUP_ID = "120363000000000042@g.us";
const PHONE_A = "+5511999990001";
const PHONE_B = "+5511999990002";
const LID_A = "5511999990001@lid";

function buildEvent(
  overrides: Partial<ApplyParticipantEventInput["event"]> = {}
): ApplyParticipantEventInput {
  return {
    providerInstanceId: null,
    event: {
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      eventType: "joined_add",
      targets: [{ phone: PHONE_A, senderExternalId: null }],
      actor: { phone: PHONE_B, senderExternalId: null },
      displayName: "Alice",
      occurredAt: "2026-04-10T10:00:00.000Z",
      sourceWebhookMessageId: "webhook-1",
      sourceNotification: "GROUP_PARTICIPANT_ADD",
      rawPayload: {},
      ...overrides,
    },
  };
}

describe.skipIf(!INTEGRATION)("GroupParticipantsService (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let service: InstanceType<typeof GroupParticipantsService>;

  beforeAll(async () => {
    testDb = await createTestDb();
    const repo = new GroupParticipantsRepository(testDb.db);
    const messagingGroupsRepo = new MessagingGroupsRepository(testDb.db);
    // Integration test cobre só applyEvent — instanceService/taskService não
    // participam desse caminho; omitidos propositalmente.
    service = new GroupParticipantsService({ repo, messagingGroupsRepo });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participant_events RESTART IDENTITY CASCADE`;
  });

  it("add → promote → demote → leave preserva snapshot e gera 4 eventos", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    await service.applyEvent(
      buildEvent({ eventType: "promoted_admin", sourceWebhookMessageId: "w-2" })
    );
    await service.applyEvent(
      buildEvent({ eventType: "demoted_member", sourceWebhookMessageId: "w-3" })
    );
    await service.applyEvent(
      buildEvent({
        eventType: "left_voluntary",
        sourceWebhookMessageId: "w-4",
        occurredAt: "2026-04-10T11:00:00.000Z",
      })
    );

    const [row] = await testDb.sql<
      Array<{ status: string; role: string; left_at: unknown; leave_reason: string | null }>
    >`SELECT status, role, left_at, leave_reason FROM group_participants WHERE phone = ${PHONE_A}`;
    expect(row).toBeDefined();
    expect(row?.status).toBe("left");
    expect(row?.role).toBe("member");
    expect(row?.leave_reason).toBe("left_voluntarily");
    expect(row?.left_at).toBeTruthy();

    const events = await testDb.sql<Array<{ event_type: string }>>`
      SELECT event_type FROM group_participant_events WHERE target_phone = ${PHONE_A} ORDER BY occurred_at
    `;
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.event_type)).toEqual([
      "joined_add",
      "promoted_admin",
      "demoted_member",
      "left_voluntary",
    ]);
  });

  it("webhook duplicado é idempotente (não duplica evento)", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "dedup-1" }));
    const outcome = await service.applyEvent(buildEvent({ sourceWebhookMessageId: "dedup-1" }));
    expect(outcome.eventsSkipped).toBe(1);
    expect(outcome.eventsInserted).toBe(0);

    const [count] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*) FROM group_participant_events WHERE source_webhook_message_id = 'dedup-1'
    `;
    expect(count?.count).toBe("1");
  });

  it("re-entrada reativa participant (status=active, leftAt=null)", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    await service.applyEvent(
      buildEvent({
        eventType: "left_voluntary",
        sourceWebhookMessageId: "w-2",
        occurredAt: "2026-04-10T11:00:00.000Z",
      })
    );
    await service.applyEvent(
      buildEvent({
        eventType: "joined_add",
        sourceWebhookMessageId: "w-3",
        occurredAt: "2026-04-10T12:00:00.000Z",
      })
    );

    const [row] = await testDb.sql<
      Array<{ status: string; left_at: Date | null; leave_reason: string | null }>
    >`SELECT status, left_at, leave_reason FROM group_participants WHERE phone = ${PHONE_A}`;
    expect(row?.status).toBe("active");
    expect(row?.left_at).toBeNull();
    expect(row?.leave_reason).toBeNull();
  });

  it("consolida identificadores: phone → LID no mesmo participante", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    // Próximo evento chega só com LID — deveria fazer match e atualizar, não criar novo.
    await service.applyEvent(
      buildEvent({
        eventType: "promoted_admin",
        sourceWebhookMessageId: "w-2",
        targets: [{ phone: PHONE_A, senderExternalId: LID_A }],
      })
    );

    const rows = await testDb.sql<
      Array<{ phone: string | null; sender_external_id: string | null; role: string }>
    >`SELECT phone, sender_external_id, role FROM group_participants WHERE group_external_id = ${GROUP_ID}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe(PHONE_A);
    expect(rows[0]?.sender_external_id).toBe(LID_A);
    expect(rows[0]?.role).toBe("admin");
  });

  describe("C1 — split de identidade (phone/LID em rows distintos)", () => {
    it("evento com phone+LID não explode quando já existem 2 rows conflitantes", async () => {
      // Row A: só phone
      await service.applyEvent(
        buildEvent({
          sourceWebhookMessageId: "w-a",
          targets: [{ phone: PHONE_A, senderExternalId: null }],
        })
      );
      // Row B: só LID (outro sourceWebhook — dedup aceita)
      await service.applyEvent(
        buildEvent({
          sourceWebhookMessageId: "w-b",
          targets: [{ phone: null, senderExternalId: LID_A }],
        })
      );

      const before = await testDb.sql<Array<{ id: string }>>`
        SELECT id FROM group_participants WHERE group_external_id = ${GROUP_ID}
      `;
      expect(before).toHaveLength(2);

      // Agora chega evento de promote com ambos — NÃO deve quebrar.
      await expect(
        service.applyEvent(
          buildEvent({
            eventType: "promoted_admin",
            sourceWebhookMessageId: "w-c",
            targets: [{ phone: PHONE_A, senderExternalId: LID_A }],
          })
        )
      ).resolves.toBeDefined();

      // Ainda 2 rows (split mantido — sem merge automático).
      const after = await testDb.sql<
        Array<{ phone: string | null; sender_external_id: string | null; role: string }>
      >`SELECT phone, sender_external_id, role FROM group_participants WHERE group_external_id = ${GROUP_ID} ORDER BY first_seen_at`;
      expect(after).toHaveLength(2);
      // O row que bateu por LID (B) foi promovido; o outro não foi tocado por esse evento.
      const promoted = after.find((r) => r.sender_external_id === LID_A);
      expect(promoted?.role).toBe("admin");
      // phone do row B NÃO foi preenchido (porque row A já tem esse phone).
      expect(promoted?.phone).toBeNull();
    });
  });
});

describe.skipIf(!INTEGRATION)(
  "GroupParticipantsService.recordSeenFromMessage (integration)",
  () => {
    let testDb: Awaited<ReturnType<typeof createTestDb>>;
    let service: InstanceType<typeof GroupParticipantsService>;

    beforeAll(async () => {
      testDb = await createTestDb();
      const repo = new GroupParticipantsRepository(testDb.db);
      const messagingGroupsRepo = new MessagingGroupsRepository(testDb.db);
      service = new GroupParticipantsService({ repo, messagingGroupsRepo });
    });

    afterAll(async () => {
      await testDb.drop();
    });

    beforeEach(async () => {
      await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
      await testDb.sql`TRUNCATE TABLE group_participant_events RESTART IDENTITY CASCADE`;
    });

    it("cria snapshot e NÃO insere em group_participant_events", async () => {
      const outcome = await service.recordSeenFromMessage({
        providerInstanceId: null,
        providerKind: "whatsapp_zapi",
        protocol: "whatsapp",
        groupExternalId: GROUP_ID,
        sender: { phone: PHONE_A, senderExternalId: null },
        displayName: "Alice",
        seenAt: "2026-04-10T10:00:00.000Z",
      });

      expect(outcome).toEqual({ status: "upserted" });

      const snapshots = await testDb.sql<
        Array<{ phone: string | null; status: string; display_name: string | null }>
      >`SELECT phone, status, display_name FROM group_participants WHERE group_external_id = ${GROUP_ID}`;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.phone).toBe(PHONE_A);
      expect(snapshots[0]?.status).toBe("active");
      expect(snapshots[0]?.display_name).toBe("Alice");

      const [eventsCount] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*) FROM group_participant_events
    `;
      expect(eventsCount?.count).toBe("0");
    });

    it("atualiza last_event_at em senders já existentes", async () => {
      const first = "2026-04-10T10:00:00.000Z";
      const later = "2026-04-10T12:30:00.000Z";

      await service.recordSeenFromMessage({
        providerInstanceId: null,
        providerKind: "whatsapp_zapi",
        protocol: "whatsapp",
        groupExternalId: GROUP_ID,
        sender: { phone: PHONE_A, senderExternalId: null },
        displayName: "Alice",
        seenAt: first,
      });
      await service.recordSeenFromMessage({
        providerInstanceId: null,
        providerKind: "whatsapp_zapi",
        protocol: "whatsapp",
        groupExternalId: GROUP_ID,
        sender: { phone: PHONE_A, senderExternalId: null },
        displayName: "Alice",
        seenAt: later,
      });

      const [row] = await testDb.sql<
        Array<{ last_event_at: Date; first_seen_at: Date }>
      >`SELECT last_event_at, first_seen_at FROM group_participants WHERE phone = ${PHONE_A}`;
      expect(new Date(row?.last_event_at ?? 0).toISOString()).toBe(later);
      expect(new Date(row?.first_seen_at ?? 0).toISOString()).toBe(first);
    });

    it("sender sem phone nem LID retorna skipped", async () => {
      const outcome = await service.recordSeenFromMessage({
        providerInstanceId: null,
        providerKind: "whatsapp_zapi",
        protocol: "whatsapp",
        groupExternalId: GROUP_ID,
        sender: { phone: null, senderExternalId: null },
        displayName: null,
        seenAt: "2026-04-10T10:00:00.000Z",
      });
      expect(outcome.status).toBe("skipped");

      const [count] = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*) FROM group_participants
    `;
      expect(count?.count).toBe("0");
    });
  }
);

describe.skipIf(!INTEGRATION)("GroupParticipantsService.applyEvent — concorrência", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let service: InstanceType<typeof GroupParticipantsService>;

  beforeAll(async () => {
    testDb = await createTestDb();
    const repo = new GroupParticipantsRepository(testDb.db);
    const messagingGroupsRepo = new MessagingGroupsRepository(testDb.db);
    service = new GroupParticipantsService({ repo, messagingGroupsRepo });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participant_events RESTART IDENTITY CASCADE`;
  });

  it("L4 — Promise.all com mesmo target não quebra unique constraint", async () => {
    // Race simulada: dois applyEvent concorrentes pro mesmo phone. Esperado:
    // um insert ganha, outro cai no onConflictDoNothing + re-find + update. Sem exceção.
    await expect(
      Promise.all([
        service.applyEvent(
          buildEvent({
            sourceWebhookMessageId: "race-1",
            targets: [{ phone: PHONE_A, senderExternalId: null }],
          })
        ),
        service.applyEvent(
          buildEvent({
            sourceWebhookMessageId: "race-2",
            targets: [{ phone: PHONE_A, senderExternalId: null }],
          })
        ),
      ])
    ).resolves.toBeDefined();

    const snapshots = await testDb.sql<Array<{ phone: string }>>`
      SELECT phone FROM group_participants WHERE phone = ${PHONE_A}
    `;
    expect(snapshots).toHaveLength(1);

    // Ambos os webhooks são eventos distintos (source_webhook_message_id diferente)
    // — ambos devem ter inserido row em events.
    const events = await testDb.sql<Array<{ source_webhook_message_id: string }>>`
      SELECT source_webhook_message_id FROM group_participant_events WHERE target_phone = ${PHONE_A}
    `;
    expect(events.map((e) => e.source_webhook_message_id).sort()).toEqual(["race-1", "race-2"]);
  });
});

describe.skipIf(!INTEGRATION)("GroupParticipantsService.applyEvent — role guards", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let service: InstanceType<typeof GroupParticipantsService>;

  beforeAll(async () => {
    testDb = await createTestDb();
    const repo = new GroupParticipantsRepository(testDb.db);
    const messagingGroupsRepo = new MessagingGroupsRepository(testDb.db);
    service = new GroupParticipantsService({ repo, messagingGroupsRepo });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE group_participants RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE group_participant_events RESTART IDENTITY CASCADE`;
  });

  it("L5 — demote em owner NÃO rebaixa para member", async () => {
    // Cria participante via join…
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    // …força role=owner via UPDATE direto (não há evento de promote owner no fluxo).
    await testDb.sql`UPDATE group_participants SET role = 'owner' WHERE phone = ${PHONE_A}`;

    // Um demote chega: não deve rebaixar owner.
    await service.applyEvent(
      buildEvent({ eventType: "demoted_member", sourceWebhookMessageId: "w-2" })
    );

    const [row] = await testDb.sql<Array<{ role: string }>>`
      SELECT role FROM group_participants WHERE phone = ${PHONE_A}
    `;
    expect(row?.role).toBe("owner");
  });

  it("L5 — demote em admin rebaixa para member", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    await service.applyEvent(
      buildEvent({ eventType: "promoted_admin", sourceWebhookMessageId: "w-2" })
    );
    await service.applyEvent(
      buildEvent({ eventType: "demoted_member", sourceWebhookMessageId: "w-3" })
    );

    const [row] = await testDb.sql<Array<{ role: string }>>`
      SELECT role FROM group_participants WHERE phone = ${PHONE_A}
    `;
    expect(row?.role).toBe("member");
  });

  it("L5 — demote em member comum continua member (no-op)", async () => {
    await service.applyEvent(buildEvent({ sourceWebhookMessageId: "w-1" }));
    await service.applyEvent(
      buildEvent({ eventType: "demoted_member", sourceWebhookMessageId: "w-2" })
    );

    const [row] = await testDb.sql<Array<{ role: string }>>`
      SELECT role FROM group_participants WHERE phone = ${PHONE_A}
    `;
    expect(row?.role).toBe("member");
  });
});
