import { beforeEach, describe, expect, it, mock } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_INSTANCES = JSON.stringify([
  { instance_id: "i1", instance_token: "t1", client_token: "c1" },
]);
process.env.HTTP_API_KEY = VALID_API_KEY;
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = "test-webhook-secret";

const { Elysia } = await import("elysia");
const { tasksModule } = await import("./index.ts");

interface ErrorResponse {
  error: string;
  details?: unknown;
}

interface AcceptedResponse {
  accepted: number;
  duplicates: number;
}

function makeTaskService() {
  return {
    enqueue: mock((jobs: unknown[]) =>
      Promise.resolve({ accepted: jobs.length, duplicates: 0, ids: [] as string[] })
    ),
    claimForExecution: mock(() => Promise.resolve(null)),
    markSucceeded: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
    markDropped: mock(() => Promise.resolve()),
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve({ data: [], pagination: { limit: 20, offset: 0, total: 0 } })),
  };
}

type MockTaskService = ReturnType<typeof makeTaskService>;

function buildApp(taskService: MockTaskService) {
  // biome-ignore lint/suspicious/noExplicitAny: mock de TaskService para testes
  return new Elysia().use(tasksModule({ taskService: taskService as any }));
}

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

function makeDeleteMessageJob(id = "550e8400-e29b-41d4-a716-446655440001") {
  return {
    id,
    type: "whatsapp.delete_message" as const,
    createdAt: "2026-04-10T00:00:00Z",
    payload: {
      providerInstanceId: PROVIDER_INSTANCE_ID,
      messageId: "msg-1",
      phone: "5511999990001",
      owner: true,
    },
  };
}

function makeRemoveParticipantJob(id = "550e8400-e29b-41d4-a716-446655440002") {
  return {
    id,
    type: "whatsapp.remove_participant" as const,
    createdAt: "2026-04-10T00:00:00Z",
    payload: {
      providerInstanceId: PROVIDER_INSTANCE_ID,
      groupId: "group-1",
      phones: ["+5511999990001"],
    },
  };
}

function postTasks(
  app: ReturnType<typeof buildApp>,
  body: unknown,
  apiKey?: string | null,
  rawBody?: string
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (apiKey !== null) {
    headers.set("x-api-key", apiKey ?? VALID_API_KEY);
  }

  return app.handle(
    new Request("http://localhost/tasks", {
      method: "POST",
      headers,
      body: rawBody ?? JSON.stringify(body),
    })
  );
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let taskService: MockTaskService;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  taskService = makeTaskService();
  app = buildApp(taskService);
});

describe("POST /tasks", () => {
  describe("autenticação", () => {
    it("401 quando x-api-key está ausente", async () => {
      const res = await postTasks(app, [makeDeleteMessageJob()], null);
      expect(res.status).toBe(401);
    });

    it("401 quando x-api-key está incorreta", async () => {
      const res = await postTasks(app, [makeDeleteMessageJob()], "wrong-key");
      expect(res.status).toBe(401);
    });

    it("401 quando x-api-key está vazia", async () => {
      const res = await postTasks(app, [makeDeleteMessageJob()], "");
      expect(res.status).toBe(401);
    });
  });

  describe("validação do body", () => {
    it("400 quando body não é JSON válido", async () => {
      const res = await postTasks(app, null, VALID_API_KEY, "not-json{{{");
      expect(res.status).toBe(400);
      const data = await readJson<ErrorResponse>(res);
      expect(data.error).toBe("Invalid JSON");
    });

    it("400 quando body não é um array", async () => {
      const res = await postTasks(app, { not: "an-array" });
      expect(res.status).toBe(400);
    });

    it("400 quando array está vazio", async () => {
      const res = await postTasks(app, []);
      expect(res.status).toBe(400);
    });

    it("400 quando um job tem schema inválido", async () => {
      const res = await postTasks(app, [{ type: "unknown_type", id: "x" }]);
      expect(res.status).toBe(400);
      const data = await readJson<ErrorResponse>(res);
      expect(data.details).toBeDefined();
    });

    it("400 quando array excede 1000 items", async () => {
      const jobs = Array.from({ length: 1001 }, (_, i) =>
        makeDeleteMessageJob(`550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`)
      );
      const res = await postTasks(app, jobs);
      expect(res.status).toBe(400);
    });

    it("413 quando payload excede 2 MB", async () => {
      const largeBody = JSON.stringify({ pad: "a".repeat(2 * 1024 * 1024 + 128) });
      const res = await postTasks(app, null, VALID_API_KEY, largeBody);
      expect(res.status).toBe(413);
      const data = await readJson<ErrorResponse>(res);
      expect(data.error).toBe("Payload too large");
    });
  });

  describe("happy path", () => {
    it("202 e chama enqueue para batch válido", async () => {
      const jobs = [
        makeDeleteMessageJob("550e8400-e29b-41d4-a716-446655440010"),
        makeDeleteMessageJob("550e8400-e29b-41d4-a716-446655440011"),
      ];

      const res = await postTasks(app, jobs);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(2);
      expect(data.duplicates).toBe(0);
      expect(taskService.enqueue).toHaveBeenCalledTimes(1);
    });

    it("202 para batch com um único job", async () => {
      const res = await postTasks(app, [makeDeleteMessageJob()]);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(1);
      expect(taskService.enqueue).toHaveBeenCalledTimes(1);
    });

    it("202 para batch misto (delete_message + remove_participant)", async () => {
      const jobs = [
        makeDeleteMessageJob("550e8400-e29b-41d4-a716-446655440020"),
        makeRemoveParticipantJob("550e8400-e29b-41d4-a716-446655440021"),
      ];

      const res = await postTasks(app, jobs);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(2);
    });

    it("passa os jobs validados para o enqueue", async () => {
      const job = makeDeleteMessageJob("550e8400-e29b-41d4-a716-446655440030");

      await postTasks(app, [job]);

      expect(taskService.enqueue).toHaveBeenCalledTimes(1);

      const firstCall = taskService.enqueue.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) throw new Error("enqueue should have at least one call");

      const [jobs] = firstCall;
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toEqual(job);
    });
  });
});
