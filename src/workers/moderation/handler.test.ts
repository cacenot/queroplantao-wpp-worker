import { describe, expect, it, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY = "test-api-key-secret";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "test-service-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";

const { NonRetryableError } = await import("../../lib/errors.ts");
const { createModerationExecuteJob } = await import("./handler.ts");

import type { JobSchema } from "../../jobs/schemas.ts";

const PROVIDER = "11111111-1111-1111-1111-111111111111";

const DELETE_JOB: JobSchema = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  type: "whatsapp.delete_message",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: {
    providerInstanceId: PROVIDER,
    messageId: "msg-1",
    phone: "5511999990001",
    owner: true,
  },
};

const REMOVE_JOB: JobSchema = {
  id: "550e8400-e29b-41d4-a716-446655440002",
  type: "whatsapp.remove_participant",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: { providerInstanceId: PROVIDER, groupId: "g-1", phones: ["+5511999990001"] },
};

function makeDeps() {
  return {
    moderationsRepo: {} as never,
    groupMessagesRepo: {} as never,
    moderate: mock(() => Promise.resolve({} as never)),
    enforcement: {} as never,
    participantsService: {
      applyEvent: mock(() => Promise.resolve({ upserted: 1, eventsInserted: 1, eventsSkipped: 0 })),
    } as never,
  };
}

describe("moderation-worker executeJob", () => {
  it("delete_message → NonRetryableError (guarda contra routing quebrado)", async () => {
    const executeJob = createModerationExecuteJob(makeDeps());

    await expect(executeJob(DELETE_JOB)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("remove_participant → NonRetryableError (guarda contra routing quebrado)", async () => {
    const executeJob = createModerationExecuteJob(makeDeps());

    await expect(executeJob(REMOVE_JOB)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("ingest_participant_event → delega ao participantsService", async () => {
    const deps = makeDeps();
    const executeJob = createModerationExecuteJob(deps);
    const INGEST_JOB: JobSchema = {
      id: "550e8400-e29b-41d4-a716-446655440003",
      type: "whatsapp.ingest_participant_event",
      createdAt: "2026-04-10T00:00:00.000Z",
      payload: {
        providerInstanceId: PROVIDER,
        event: {
          providerKind: "whatsapp_zapi",
          protocol: "whatsapp",
          groupExternalId: "120363@g.us",
          eventType: "joined_add",
          targets: [{ phone: "+5511999990010", senderExternalId: null }],
          actor: { phone: "+5511999990002", senderExternalId: null },
          displayName: "Alice",
          occurredAt: "2026-04-10T00:00:00.000Z",
          sourceWebhookMessageId: "msg-1",
          sourceNotification: "GROUP_PARTICIPANT_ADD",
          rawPayload: {},
        },
      },
    };

    await executeJob(INGEST_JOB);
    const applyEvent = (
      deps.participantsService as unknown as { applyEvent: ReturnType<typeof mock> }
    ).applyEvent;
    expect(applyEvent).toHaveBeenCalledTimes(1);
  });
});
