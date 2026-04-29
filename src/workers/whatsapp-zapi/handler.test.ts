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
const { createZapiExecuteJob } = await import("./handler.ts");

import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { GatewayRegistry } from "../../gateways/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../../gateways/whatsapp/types.ts";
import type { JobSchema } from "../../jobs/schemas.ts";

const PROVIDER = "11111111-1111-1111-1111-111111111111";

function makeExecutor(): WhatsAppExecutor {
  return { execute: mock(() => Promise.resolve()) as WhatsAppExecutor["execute"] };
}

function makeRegistry(executor: WhatsAppExecutor): GatewayRegistry<WhatsAppProvider> {
  return { getByInstanceId: () => executor };
}

function makeGroupMessagesRepo() {
  return {
    markRemoved: mock(() => Promise.resolve(1)),
  } as unknown as GroupMessagesRepository;
}

function makeOutboundRepo() {
  return {
    markSending: mock(() => Promise.resolve()),
    markSent: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
  } as unknown as OutboundMessagesRepository;
}

const MODERATE_JOB: JobSchema = {
  id: "550e8400-e29b-41d4-a716-446655440099",
  type: "whatsapp.moderate_group_message",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: { moderationId: "550e8400-e29b-41d4-a716-446655440010" },
};

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

describe("zapi-worker executeJob", () => {
  it("executa delete_message via executor", async () => {
    const executor = makeExecutor();
    const executeJob = createZapiExecuteJob({
      whatsappGatewayRegistry: makeRegistry(executor),
      groupMessagesRepo: makeGroupMessagesRepo(),
      outboundMessagesRepo: makeOutboundRepo(),
    });

    await executeJob(DELETE_JOB);

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("moderate_group_message → NonRetryableError (guarda contra routing quebrado)", async () => {
    const executeJob = createZapiExecuteJob({
      whatsappGatewayRegistry: makeRegistry(makeExecutor()),
      groupMessagesRepo: makeGroupMessagesRepo(),
      outboundMessagesRepo: makeOutboundRepo(),
    });

    await expect(executeJob(MODERATE_JOB)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("envia send_message via executor + atualiza outbound", async () => {
    const executor: WhatsAppExecutor = {
      execute: mock(() =>
        Promise.resolve({ externalMessageId: "wamid.123", raw: {} })
      ) as WhatsAppExecutor["execute"],
    };
    const outboundRepo = makeOutboundRepo();
    const executeJob = createZapiExecuteJob({
      whatsappGatewayRegistry: makeRegistry(executor),
      groupMessagesRepo: makeGroupMessagesRepo(),
      outboundMessagesRepo: outboundRepo,
    });

    await executeJob({
      id: "550e8400-e29b-41d4-a716-446655440002",
      type: "whatsapp.send_message",
      createdAt: "2026-04-10T00:00:00.000Z",
      payload: {
        providerInstanceId: PROVIDER,
        outboundMessageId: "550e8400-e29b-41d4-a716-446655440003",
        target: { kind: "contact", externalId: "+5511999990001" },
        content: { kind: "text", message: "olá" },
      },
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(outboundRepo.markSending).toHaveBeenCalledTimes(1);
    expect(outboundRepo.markSent).toHaveBeenCalledTimes(1);
  });
});
