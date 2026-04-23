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
const { GroupMessagesRepository } = await import("./group-messages-repository.ts");

import type { NewGroupMessage } from "../schema/group-messages.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

function buildMessage(overrides: Partial<NewGroupMessage> = {}): NewGroupMessage {
  return {
    ingestionDedupeHash: `dedupe-${Math.random().toString(36).slice(2)}`,
    contentHash: "hash-1",
    protocol: "whatsapp",
    providerKind: "whatsapp_zapi",
    groupExternalId: "120363000000000001@g.us",
    externalMessageId: "MSG-ABC",
    messageType: "text",
    hasText: true,
    sentAt: new Date(),
    ...overrides,
  };
}

describe.skipIf(!INTEGRATION)("GroupMessagesRepository.markRemoved (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof GroupMessagesRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new GroupMessagesRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE group_messages RESTART IDENTITY CASCADE`;
  });

  it("seta removed_at e retorna 1 quando row casa", async () => {
    const { row } = await repo.upsertByIngestionHash(
      buildMessage({ externalMessageId: "msg-1", groupExternalId: "grp-1@g.us" }),
      null
    );

    const updated = await repo.markRemoved("msg-1", "grp-1@g.us");

    expect(updated).toBe(1);
    const after = await repo.findById(row.id);
    expect(after?.removedAt).toBeInstanceOf(Date);
  });

  it("retorna 0 quando (external_message_id, group_external_id) não casa", async () => {
    await repo.upsertByIngestionHash(
      buildMessage({ externalMessageId: "msg-1", groupExternalId: "grp-1@g.us" }),
      null
    );

    const updated = await repo.markRemoved("msg-ausente", "grp-1@g.us");
    expect(updated).toBe(0);
  });

  it("é idempotente: segunda chamada retorna 0 e não altera removed_at", async () => {
    const { row } = await repo.upsertByIngestionHash(
      buildMessage({ externalMessageId: "msg-1", groupExternalId: "grp-1@g.us" }),
      null
    );

    const first = await repo.markRemoved("msg-1", "grp-1@g.us");
    const firstSnapshot = await repo.findById(row.id);
    const firstRemovedAt = firstSnapshot?.removedAt;

    const second = await repo.markRemoved("msg-1", "grp-1@g.us");
    const after = await repo.findById(row.id);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(after?.removedAt?.getTime()).toBe(firstRemovedAt?.getTime());
  });

  it("só afeta linha do grupo certo — mesmo external_message_id em outro grupo não é tocado", async () => {
    const { row: rowA } = await repo.upsertByIngestionHash(
      buildMessage({ externalMessageId: "msg-shared", groupExternalId: "grp-A@g.us" }),
      null
    );
    const { row: rowB } = await repo.upsertByIngestionHash(
      buildMessage({ externalMessageId: "msg-shared", groupExternalId: "grp-B@g.us" }),
      null
    );

    const updated = await repo.markRemoved("msg-shared", "grp-A@g.us");

    expect(updated).toBe(1);
    const afterA = await repo.findById(rowA.id);
    const afterB = await repo.findById(rowB.id);
    expect(afterA?.removedAt).toBeInstanceOf(Date);
    expect(afterB?.removedAt).toBeNull();
  });
});
