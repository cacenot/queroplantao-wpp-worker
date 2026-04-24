import { describe, expect, it } from "bun:test";

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

const { queueForJob, priorityForJob, retryQueueForJob, dlqForJob } = await import("./routing.ts");

describe("jobs/routing", () => {
  it("roteia delete e remove pra fila zapi", () => {
    expect(queueForJob("whatsapp.delete_message")).toBe("wpp.zapi");
    expect(queueForJob("whatsapp.remove_participant")).toBe("wpp.zapi");
  });

  it("roteia moderate e ingest_participant_event pra fila moderation", () => {
    expect(queueForJob("whatsapp.moderate_group_message")).toBe("wpp.moderation");
    expect(queueForJob("whatsapp.ingest_participant_event")).toBe("wpp.moderation");
  });

  it("priority: delete=10, remove=7, moderate/ingest_participant_event=undefined", () => {
    expect(priorityForJob("whatsapp.delete_message")).toBe(10);
    expect(priorityForJob("whatsapp.remove_participant")).toBe(7);
    expect(priorityForJob("whatsapp.moderate_group_message")).toBeUndefined();
    expect(priorityForJob("whatsapp.ingest_participant_event")).toBeUndefined();
  });

  it("retry e dlq seguem convenção <queue>.retry / .dlq", () => {
    expect(retryQueueForJob("whatsapp.delete_message")).toBe("wpp.zapi.retry");
    expect(dlqForJob("whatsapp.delete_message")).toBe("wpp.zapi.dlq");
    expect(retryQueueForJob("whatsapp.moderate_group_message")).toBe("wpp.moderation.retry");
    expect(dlqForJob("whatsapp.moderate_group_message")).toBe("wpp.moderation.dlq");
  });
});
