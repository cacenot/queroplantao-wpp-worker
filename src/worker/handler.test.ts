import { beforeEach, describe, expect, it, mock } from "bun:test";

// env é parseado no primeiro load e congelado. HTTP_API_KEY é sobrescrito unconditionally
// para bater com VALID_API_KEY dos testes de rota HTTP (que rodam no mesmo processo).
// Outros vars usam ??= para não sobrescrever o .env — integration tests precisam do
// DATABASE_URL real.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.AMQP_QUEUE ??= "wpp.actions";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY = "test-api-key-secret";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";

const { ConsumerStatus } = await import("rabbitmq-client");
const { NonRetryableError } = await import("../lib/errors.ts");
const { createJobHandler } = await import("./handler.ts");

import type { AsyncMessage } from "rabbitmq-client";
import type { MessageAnalysis } from "../ai/moderator.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import type { RetryTopology } from "../lib/retry-topology.ts";
import type { GatewayRegistry } from "../messaging/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../messaging/whatsapp/types.ts";
import type { TaskService } from "../services/task/index.ts";

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

const ANALYZE_MESSAGE_JOB = {
  id: "550e8400-e29b-41d4-a716-446655440002",
  type: "whatsapp.analyze_message",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: { hash: "abc123", text: "hello" },
} as const;

const REMOVE_PARTICIPANT_JOB = {
  id: "550e8400-e29b-41d4-a716-446655440003",
  type: "whatsapp.remove_participant",
  createdAt: "2026-04-10T00:00:00.000Z",
  payload: {
    providerInstanceId: PROVIDER_INSTANCE_ID,
    groupId: "group-1",
    phones: ["5511999990001"],
  },
} as const;

function makeMsg(body: unknown): AsyncMessage {
  return { body } as unknown as AsyncMessage;
}

function makeTopology(overrides: Partial<RetryTopology> = {}): RetryTopology {
  return {
    mainQueue: "wpp.actions",
    retryQueue: "wpp.actions.retry",
    dlqName: "wpp.actions.dlq",
    retryDelayMs: 120000,
    maxRetries: 3,
    ...overrides,
  };
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

function makeExecutor(impl: () => Promise<void> = () => Promise.resolve()): WhatsAppExecutor {
  return { execute: mock(impl) as WhatsAppExecutor["execute"] };
}

function makeClassify(result?: MessageAnalysis) {
  const defaultResult = {
    reason: "ok",
    partner: null,
    category: "clean",
    confidence: 0.9,
    action: "allow",
  } as unknown as MessageAnalysis;
  return mock(() => Promise.resolve(result ?? defaultResult));
}

function makeAdminApi() {
  return {
    submitMessageAnalysis: mock(() => Promise.resolve()),
  } as unknown as QpAdminApiClient;
}

function makeRegistry(
  resolver: (id: string) => WhatsAppExecutor | undefined
): GatewayRegistry<WhatsAppProvider> {
  return { getByInstanceId: (id: string) => resolver(id) };
}

interface HandlerDeps {
  taskService: ReturnType<typeof makeTaskService>;
  publisher: ReturnType<typeof makePublisher>;
  whatsappGateway: WhatsAppExecutor;
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  topology: RetryTopology;
  onSuccess: ReturnType<typeof mock>;
}

function makeHandler(
  overrides: Partial<{
    whatsappGateway: WhatsAppExecutor;
    whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
    classifyMessage: ReturnType<typeof makeClassify>;
    taskService: ReturnType<typeof makeTaskService>;
    publisher: ReturnType<typeof makePublisher>;
    topology: RetryTopology;
  }> = {}
): { handler: JobHandler; deps: HandlerDeps } {
  const whatsappGateway = overrides.whatsappGateway ?? makeExecutor();
  const whatsappGatewayRegistry =
    overrides.whatsappGatewayRegistry ?? makeRegistry(() => whatsappGateway);
  const classifyMessage = overrides.classifyMessage ?? makeClassify();
  const taskService = overrides.taskService ?? makeTaskService();
  const publisher = overrides.publisher ?? makePublisher();
  const topology = overrides.topology ?? makeTopology();
  const onSuccess = mock(() => {});
  const adminApi = makeAdminApi();

  const handler = createJobHandler({
    whatsappGatewayRegistry,
    classifyMessage: classifyMessage as unknown as (text: string) => Promise<MessageAnalysis>,
    adminApi,
    // biome-ignore lint/suspicious/noExplicitAny: fake service tipado via makeTaskService
    taskService: taskService as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake publisher tipado via makePublisher
    publisher: publisher as any,
    topology,
    onSuccess,
  });

  return {
    handler,
    deps: {
      taskService,
      publisher,
      whatsappGateway,
      whatsappGatewayRegistry,
      topology,
      onSuccess,
    },
  };
}

describe("handler — schema inválido", () => {
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

describe("handler — claim lifecycle", () => {
  it("DROP quando claimForExecution retorna null (task terminal)", async () => {
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.resolve(null)),
    });
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(0);
    expect(deps.whatsappGateway.execute).toHaveBeenCalledTimes(0);
  });

  it("fallback: claim throws → executa action usando job.attempt", async () => {
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.reject(new Error("DB down"))),
    });
    const { handler, deps } = makeHandler({ taskService });

    const result = await handler(makeMsg({ ...DELETE_MESSAGE_JOB, attempt: 2 }));

    expect(deps.whatsappGateway.execute).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });
});

describe("handler — happy path", () => {
  let taskService: ReturnType<typeof makeTaskService>;

  beforeEach(() => {
    taskService = makeTaskService();
  });

  it("delete_message: chama executor, markSucceeded e onSuccess", async () => {
    const executor = makeExecutor();
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markSucceeded).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.onSuccess).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledTimes(0);
  });

  it("remove_participant: chama executor e markSucceeded", async () => {
    const executor: WhatsAppExecutor = {
      execute: mock(() => Promise.resolve({ value: true })) as WhatsAppExecutor["execute"],
    };
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService });

    const result = await handler(makeMsg(REMOVE_PARTICIPANT_JOB));

    expect(result).toBeUndefined();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markSucceeded).toHaveBeenCalledWith(REMOVE_PARTICIPANT_JOB.id);
  });

  it("analyze_message: chama classify + admin api e markSucceeded", async () => {
    const classify = makeClassify();
    const { handler, deps } = makeHandler({ classifyMessage: classify, taskService });

    const result = await handler(makeMsg(ANALYZE_MESSAGE_JOB));

    expect(result).toBeUndefined();
    expect(classify).toHaveBeenCalledWith("hello");
    expect(deps.taskService.markSucceeded).toHaveBeenCalledWith(ANALYZE_MESSAGE_JOB.id);
  });
});

describe("handler — gateway registry", () => {
  it("providerInstanceId desconhecido → NonRetryableError → DLQ", async () => {
    const registry = makeRegistry(() => undefined);
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      whatsappGatewayRegistry: registry,
      publisher,
    });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.dlq", durable: true },
      expect.anything()
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(0);
  });

  it("resolve executor por providerInstanceId do payload", async () => {
    const executorA = makeExecutor();
    const executorB = makeExecutor();
    const registry = makeRegistry((id) => (id === PROVIDER_INSTANCE_ID ? executorA : executorB));
    const { handler } = makeHandler({ whatsappGatewayRegistry: registry });

    await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(executorA.execute).toHaveBeenCalledTimes(1);
    expect(executorB.execute).toHaveBeenCalledTimes(0);
  });
});

describe("handler — retry", () => {
  const retryableErr = new Error("transient");

  it("1ª tentativa falha → publica em retryQueue com durable e DROP", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.retry", durable: true },
      { ...DELETE_MESSAGE_JOB, attempt: 1 }
    );
    expect(deps.taskService.markRetrying).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("última tentativa permitida (attempt = maxRetries) ainda retria", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 3 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      whatsappGateway: executor,
      taskService,
      publisher,
      topology: makeTopology({ maxRetries: 3 }),
    });

    await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.retry", durable: true },
      expect.anything()
    );
  });

  it("attempt > maxRetries → DLQ, markFailed, DROP", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 4 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      whatsappGateway: executor,
      taskService,
      publisher,
      topology: makeTopology({ maxRetries: 3 }),
    });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.dlq", durable: true },
      { ...DELETE_MESSAGE_JOB, attempt: 4 }
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(0);
  });

  it("maxRetries = 0 → primeira falha já vai para DLQ", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      whatsappGateway: executor,
      taskService,
      publisher,
      topology: makeTopology({ maxRetries: 0 }),
    });

    await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.dlq", durable: true },
      expect.anything()
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
  });

  it("NonRetryableError → DLQ direto mesmo em 1ª tentativa", async () => {
    const executor = makeExecutor(() => Promise.reject(new NonRetryableError("payload inválido")));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.DROP);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.dlq", durable: true },
      expect.anything()
    );
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(0);
  });

  it("publish em retryQueue falha → REQUEUE + markRetrying", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 1 } as unknown)
      ),
    });
    const publisher = {
      send: mock(() => Promise.reject(new Error("broker fora"))),
    };
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService, publisher });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.REQUEUE);
    expect(deps.taskService.markRetrying).toHaveBeenCalledWith(DELETE_MESSAGE_JOB.id);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("publish em DLQ falha → REQUEUE", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() =>
        Promise.resolve({ id: DELETE_MESSAGE_JOB.id, attempt: 4 } as unknown)
      ),
    });
    const publisher = {
      send: mock(() => Promise.reject(new Error("broker fora"))),
    };
    const { handler, deps } = makeHandler({
      whatsappGateway: executor,
      taskService,
      publisher,
      topology: makeTopology({ maxRetries: 3 }),
    });

    const result = await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(result).toBe(ConsumerStatus.REQUEUE);
    expect(deps.taskService.markRetrying).toHaveBeenCalledTimes(1);
    expect(deps.taskService.markFailed).toHaveBeenCalledTimes(0);
  });

  it("fallback + erro retryable usa job.attempt para decidir", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.reject(new Error("DB down"))),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({
      whatsappGateway: executor,
      taskService,
      publisher,
      topology: makeTopology({ maxRetries: 3 }),
    });

    await handler(makeMsg({ ...DELETE_MESSAGE_JOB, attempt: 2 }));

    expect(deps.publisher.send).toHaveBeenCalledTimes(1);
    expect(deps.publisher.send).toHaveBeenCalledWith(
      { routingKey: "wpp.actions.retry", durable: true },
      { ...DELETE_MESSAGE_JOB, attempt: 2 }
    );
  });

  it("fallback + erro retryable sem job.attempt usa 1", async () => {
    const executor = makeExecutor(() => Promise.reject(retryableErr));
    const taskService = makeTaskService({
      claimForExecution: mock(() => Promise.reject(new Error("DB down"))),
    });
    const publisher = makePublisher();
    const { handler, deps } = makeHandler({ whatsappGateway: executor, taskService, publisher });

    await handler(makeMsg(DELETE_MESSAGE_JOB));

    expect(deps.publisher.send).toHaveBeenCalledWith(expect.anything(), {
      ...DELETE_MESSAGE_JOB,
      attempt: 1,
    });
  });
});
