import { beforeEach, describe, expect, it, mock } from "bun:test";

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

const { ConsumerStatus } = await import("rabbitmq-client");
const { NonRetryableError } = await import("../../lib/errors.ts");
const { createJobHandler } = await import("./handler-base.ts");

import type { AsyncMessage } from "rabbitmq-client";
import type { JobSchema } from "../../jobs/schemas.ts";
import type { TaskService } from "../../services/task/index.ts";

type JobHandler = ReturnType<typeof createJobHandler>;

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

const DELETE_MESSAGE_JOB = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  type: "whatsapp.delete_message",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: {
    providerInstanceId: PROVIDER_INSTANCE_ID,
    messageId: "msg-1",
    phone: "5511999990001",
    owner: true,
  },
} as const;

const REMOVE_PARTICIPANT_JOB = {
  id: "550e8400-e29b-41d4-a716-446655440003",
  type: "whatsapp.remove_participant",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: {
    providerInstanceId: PROVIDER_INSTANCE_ID,
    groupId: "group-1",
    phones: ["+5511999990001"],
  },
} as const;

const MODERATE_JOB = {
  id: "550e8400-e29b-41d4-a716-446655440099",
  type: "whatsapp.moderate_group_message",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: { moderationId: "550e8400-e29b-41d4-a716-446655440010" },
} as const;

function makeMsg(body: unknown): AsyncMessage {
  return { body } as unknown as AsyncMessage;
}

function makeTaskService(overrides: Partial<Record<keyof TaskService, unknown>> = {}) {
  return {
    enqueue: mock(() => Promise.resolve({ accepted: 0, duplicates: 0, ids: [] })),
    claimForExecution: mock(() =>
      Promise.resolve({ id: "x", attempt: 1, status: "running" } as unknown)
    ),
    markRetrying: mock(() => Promise.resolve(true)),
    markSucceeded: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
    markDropped: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve({ data: [], pagination: { limit: 20, offset: 0, total: 0 } })),
    ...overrides,
  };
}

function makePublisher() {
  return {
    send: mock(() => Promise.resolve()),
  };
}

type HandlerDeps = {
  taskService: ReturnType<typeof makeTaskService>;
  publisher: ReturnType<typeof makePublisher>;
  executeJob: ReturnType<typeof mock>;
  onSuccess: ReturnType<typeof mock>;
};

function makeHandler(
  overrides: Partial<{
    executeJob: (job: JobSchema) => Promise<void>;
    taskService: ReturnType<typeof makeTaskService>;
    publisher: ReturnType<typeof makePublisher>;
    maxRetries: number;
  }> = {}
): { handler: JobHandler; deps: HandlerDeps } {
  const taskService = overrides.taskService ?? makeTaskService();
  const publisher = overrides.publisher ?? makePublisher();
  const maxRetries = overrides.maxRetries ?? 3;
  const executeJob = mock(overrides.executeJob ?? (() => Promise.resolve()));
  const onSuccess = mock(() => {});

  const handler = createJobHandler({
    executeJob,
    // biome-ignore lint/suspicious/noExplicitAny: fake service tipado via makeTaskService
    taskService: taskService as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake publisher tipado via makePublisher
    publisher: publisher as any,
    maxRetries,
    onSuccess,
  });

  return {
    handler,
    deps: {
      taskService,
      publisher,
      executeJob,
      onSuccess,
    },
  };
}

describe("handler-base — schema inválido", () => {
  it("retorna DROP para body sem id", async () => {
    const { handler, deps } = makeHandler();

    const result = await handler(makeMsg({ foo: "bar" }));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.taskService.markDropped).toHaveBeenCalledTimes(0);
    expect(deps.publisher.send).toHaveBeenCalledTimes(0);
  });

  it("retorna DROP e chama markDropped quando id está presente", async () => {
    const { handler, deps } = makeHandler();

    const result = await handler(makeMsg({ id: "abc", type: "unknown", payload: {} }));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.taskService.markDropped).toHaveBeenCalledWith("abc", "schema_invalid");
  });
});

describe("handler-base — claim lifecycle", () => {
  it("DROP quando claimForExecution retorna null (task terminal)", async () => {
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.resolve(null)),
    });
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(0);
    expect(deps.executeJob).toHaveBeenCalledTimes(0);
  });

  it("fallback: claim throws → executa action usando job.attempt", async () => {
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.reject(new Error("DB down"))),
    });
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg({ ...DELETE_MESSAGE_JOB, attempt: 2 }));

    expect(deps.executeJob).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});

describe("handler-base — happy path", () => {
  let taskService: ReturnType<typeof makeTaskService>;

  beforeEach(() => {
    taskService = makeTaskService();
  });

  it("delete_message: chama executeJob, markSucceeded e onSuccess", async () => {
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBeUndefined();
    expect(deps.executeJob).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markSucceeded).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledTimes(0);
  });

  it("remove_participant: chama executeJob e markSucceeded", async () => {
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg(REMOVE_PARTICIPANT_JOB));

    expect(result).toBeUndefined();
    expect(deps.executeJob).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markSucceeded).toHaveBeenCalledWith(REMOVE_PARTICIPANT_JOB.id);
  });
});

describe("handler-base — retry", () => {
  const retryableErr = new Error("transient");

  it("delete: 1ª tentativa falha → publica em wpp.zapi.retry com priority 10 e DROP", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ executeJob, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.zapi.retry", durable: true, priority: 10 },
      { ...DELETE_MESSAGE_JOB, attempt: 1 }
    );
    expect(deps.taskService.markRetrying).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("moderate: falha retryable → publica em wpp.moderation.retry sem priority", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: MODERATE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ executeJob, taskService, publisher });

    await handler(makeMsg(MODERATE_JOB));

    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.moderation.retry", durable: true, priority: undefined },
      expect.anything()
    );
  });

  it("última tentativa permitida (attempt = maxRetries) ainda retria", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 3 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      executeJob,
      taskService,
      publisher,
      maxRetries: 3,
    });

    await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.zapi.retry", durable: true, priority: 10 },
      expect.anything()
    );
  });

  it("attempt > maxRetries → DLQ (wpp.zapi.dlq), markFailed, DROP", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 4 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      executeJob,
      taskService,
      publisher,
      maxRetries: 3,
    });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.zapi.dlq", durable: true, priority: 10 },
      { ...DELETE_MESSAGE_JOB, attempt: 4 }
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(0);
  });

  it("NonRetryableError → DLQ direto mesmo em 1ª tentativa", async () => {
    const executeJob = () => Promise.reject(new NonRetryableError("payload inválido"));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ executeJob, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.zapi.dlq", durable: true, priority: 10 },
      expect.anything()
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(0);
  });

  it("publish em retryQueue falha → REQUEUE + markRetrying", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = {
      send: mock(() => Promise.reject(new Error("broker fora"))),
    };
    const { handler, deps } = makeHandler({ executeJob, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.REQUEUE);
    expect(deps.taskService.markRetrying).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("publish em DLQ falha → REQUEUE", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 4 } as unknown)
      ),
    });
    const publisher = {
      send: mock(() => Promise.reject(new Error("broker fora"))),
    };
    const { handler, deps } = makeHandler({
      executeJob,
      taskService,
      publisher,
      maxRetries: 3,
    });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.REQUEUE);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("fallback + erro retryable usa job.attempt para decidir", async () => {
    const executeJob = () => Promise.reject(retryableErr);
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.reject(new Error("DB down"))),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      executeJob,
      taskService,
      publisher,
      maxRetries: 3,
    });

    await handler(makeMsg({ ...DELETE_MESSAGE_JOB, attempt: 2 }));

    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.zapi.retry", durable: true, priority: 10 },
      { ...DELETE_MESSAGE_JOB, attempt: 2 }
    );
  });
});
