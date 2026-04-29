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
const { OutboundMessagesRepository } = await import(
  "../../db/repositories/outbound-messages-repository.ts"
);
const { MessagingGroupsRepository } = await import(
  "../../db/repositories/messaging-groups-repository.ts"
);
const { MessagingProviderInstanceRepository } = await import(
  "../../db/repositories/messaging-provider-instance-repository.ts"
);
const { TaskRepository } = await import("../../db/repositories/task-repository.ts");
const { TaskService } = await import("../task/task-service.ts");
const { OutboundMessagesService } = await import("./outbound-messages-service.ts");

const INTEGRATION = process.env.INTEGRATION === "1";

const PHONE_RAW = "5547997490248";
const PHONE_E164 = "+5547997490248";
const GROUP_EXTERNAL_ID = "120363111111111111@g.us";

describe.skipIf(!INTEGRATION)("OutboundMessagesService (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let service: InstanceType<typeof OutboundMessagesService>;
  let providerInstanceId: string;
  let messagingGroupId: string;
  // Spy do publisher: o TaskService espera publish AMQP, mas integração não
  // sobe broker — basta resolver pra simular ack do broker. INSERT em tasks
  // permanece autêntico.
  let publisherSendSpy: ReturnType<typeof mock>;

  beforeAll(async () => {
    testDb = await createTestDb();
    publisherSendSpy = mock(() => Promise.resolve());

    const taskRepo = new TaskRepository(testDb.db);
    const taskService = new TaskService({
      repo: taskRepo,
      publisher: {
        send: publisherSendSpy as unknown as (env: unknown, body: unknown) => Promise<void>,
      },
    });

    service = new OutboundMessagesService({
      outboundMessagesRepo: new OutboundMessagesRepository(testDb.db),
      messagingGroupsRepo: new MessagingGroupsRepository(testDb.db),
      providerInstanceRepo: new MessagingProviderInstanceRepository(testDb.db),
      taskService,
    });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE outbound_messages RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE tasks RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE messaging_groups RESTART IDENTITY CASCADE`;
    await testDb.sql`TRUNCATE TABLE messaging_provider_instances RESTART IDENTITY CASCADE`;

    const [provider] = await testDb.sql<Array<{ id: string }>>`
      INSERT INTO messaging_provider_instances (protocol, provider_kind, display_name, redis_key)
      VALUES ('whatsapp', 'whatsapp_zapi', 'test-instance', 'qp:whatsapp')
      RETURNING id
    `;
    providerInstanceId = provider?.id ?? "";

    await testDb.sql`
      INSERT INTO zapi_instances (messaging_provider_instance_id, zapi_instance_id, instance_token)
      VALUES (${providerInstanceId}, 'zinst-1', 'tok-1')
    `;

    const [group] = await testDb.sql<Array<{ id: string }>>`
      INSERT INTO messaging_groups (external_id, protocol, name)
      VALUES (${GROUP_EXTERNAL_ID}, 'whatsapp', 'Grupo Teste')
      RETURNING id
    `;
    messagingGroupId = group?.id ?? "";

    publisherSendSpy.mockClear();
  });

  it("send para contato cria outbound + task e vincula task_id", async () => {
    const outcome = await service.send({
      providerInstanceId,
      target: { kind: "contact", phone: PHONE_RAW },
      content: { kind: "text", message: "olá" },
    });

    expect(outcome.status).toBe("queued");

    const [outbound] = await testDb.sql<
      Array<{
        id: string;
        status: string;
        target_kind: string;
        target_external_id: string;
        target_phone_e164: string | null;
        content_kind: string;
        task_id: string | null;
        provider_instance_id: string;
      }>
    >`SELECT * FROM outbound_messages WHERE id = ${outcome.outboundMessageId}`;

    expect(outbound?.status).toBe("queued");
    expect(outbound?.target_kind).toBe("contact");
    expect(outbound?.target_external_id).toBe(PHONE_E164);
    expect(outbound?.target_phone_e164).toBe(PHONE_E164);
    expect(outbound?.content_kind).toBe("text");
    expect(outbound?.provider_instance_id).toBe(providerInstanceId);
    expect(outbound?.task_id).toBe(outcome.taskId);

    const [task] = await testDb.sql<Array<{ id: string; type: string; status: string }>>`
      SELECT id, type, status FROM tasks WHERE id = ${outcome.taskId}
    `;
    expect(task?.type).toBe("whatsapp.send_message");
    expect(task?.status).toBe("queued");
    expect(publisherSendSpy).toHaveBeenCalledTimes(1);
  });

  it("send para grupo monitorado preenche messaging_group_id", async () => {
    const outcome = await service.send({
      providerInstanceId,
      target: { kind: "group", externalId: GROUP_EXTERNAL_ID },
      content: { kind: "image", imageUrl: "https://x.com/a.jpg" },
    });

    const [outbound] = await testDb.sql<
      Array<{ messaging_group_id: string | null; target_phone_e164: string | null }>
    >`SELECT * FROM outbound_messages WHERE id = ${outcome.outboundMessageId}`;

    expect(outbound?.messaging_group_id).toBe(messagingGroupId);
    expect(outbound?.target_phone_e164).toBeNull();
  });

  it("idempotencyKey duplicada não duplica row nem enfileira novo job", async () => {
    const first = await service.send({
      providerInstanceId,
      target: { kind: "contact", phone: PHONE_RAW },
      content: { kind: "text", message: "olá" },
      idempotencyKey: "dedup-key-1",
    });

    const second = await service.send({
      providerInstanceId,
      target: { kind: "contact", phone: PHONE_RAW },
      content: { kind: "text", message: "olá de novo" },
      idempotencyKey: "dedup-key-1",
    });

    expect(second.outboundMessageId).toBe(first.outboundMessageId);
    expect(second.status).toBe("deduplicated");

    const rows = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM outbound_messages WHERE idempotency_key = 'dedup-key-1'
    `;
    expect(rows[0]?.count).toBe("1");

    const tasks = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM tasks
    `;
    expect(tasks[0]?.count).toBe("1");
  });

  it("phone E.164 inválido não cria nenhuma row", async () => {
    await expect(
      service.send({
        providerInstanceId,
        target: { kind: "contact", phone: "abc-not-a-phone" },
        content: { kind: "text", message: "olá" },
      })
    ).rejects.toThrow(/Phone inválido/);

    const rows = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM outbound_messages
    `;
    expect(rows[0]?.count).toBe("0");
  });

  it("provider instance inexistente lança e não cria row", async () => {
    await expect(
      service.send({
        providerInstanceId: "00000000-0000-0000-0000-000000000000",
        target: { kind: "contact", phone: PHONE_RAW },
        content: { kind: "text", message: "olá" },
      })
    ).rejects.toThrow(/Provider instance não encontrada/);

    const rows = await testDb.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM outbound_messages
    `;
    expect(rows[0]?.count).toBe("0");
  });
});
