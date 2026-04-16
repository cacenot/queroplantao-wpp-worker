import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.AMQP_QUEUE = "test-queue";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_INSTANCES = JSON.stringify([
  { instance_id: "i1", instance_token: "t1", client_token: "c1" },
]);
process.env.HTTP_API_KEY = VALID_API_KEY;
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";

const { startHttpServer } = await import("../server.ts");

interface ErrorResponse {
  error: string;
  details?: unknown;
}

interface AcceptedResponse {
  accepted: number;
}

interface HealthResponse {
  status: string;
}

function makePublisher() {
  return {
    send: mock((_envelope: unknown, _body: unknown) => Promise.resolve()),
  };
}

type MockPublisher = ReturnType<typeof makePublisher>;

function makeDeleteMessageJob(id = "job-1") {
  return {
    id,
    type: "whatsapp.delete_message" as const,
    createdAt: "2026-04-10T00:00:00Z",
    payload: { messageId: "msg-1", phone: "5511999990001", owner: true },
  };
}

function makeRemoveParticipantJob(id = "job-2") {
  return {
    id,
    type: "whatsapp.remove_participant" as const,
    createdAt: "2026-04-10T00:00:00Z",
    payload: { groupId: "group-1", phones: ["5511999990001"] },
  };
}

function postTasks(baseUrl: string, body: unknown, apiKey?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey !== null) {
    headers["x-api-key"] = apiKey ?? VALID_API_KEY;
  }

  return fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let server: ReturnType<typeof startHttpServer>;
let publisher: MockPublisher;
let baseUrl: string;

beforeAll(() => {
  publisher = makePublisher();
  // biome-ignore lint/suspicious/noExplicitAny: mock de publisher AMQP para testes
  server = startHttpServer(publisher as any, () => true);
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

describe("POST /tasks", () => {
  describe("autenticação", () => {
    it("401 quando x-api-key está ausente", async () => {
      const res = await postTasks(baseUrl, [makeDeleteMessageJob()], null);
      expect(res.status).toBe(401);
    });

    it("401 quando x-api-key está incorreta", async () => {
      const res = await postTasks(baseUrl, [makeDeleteMessageJob()], "wrong-key");
      expect(res.status).toBe(401);
    });

    it("401 quando x-api-key está vazia", async () => {
      const res = await postTasks(baseUrl, [makeDeleteMessageJob()], "");
      expect(res.status).toBe(401);
    });
  });

  describe("validação do body", () => {
    it("400 quando body não é JSON válido", async () => {
      const res = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": VALID_API_KEY },
        body: "not-json{{{",
      });
      expect(res.status).toBe(400);
      const data = await readJson<ErrorResponse>(res);
      expect(data.error).toBe("Invalid JSON");
    });

    it("400 quando body não é um array", async () => {
      const res = await postTasks(baseUrl, { not: "an-array" });
      expect(res.status).toBe(400);
    });

    it("400 quando array está vazio", async () => {
      const res = await postTasks(baseUrl, []);
      expect(res.status).toBe(400);
    });

    it("400 quando um job tem schema inválido", async () => {
      const res = await postTasks(baseUrl, [{ type: "unknown_type", id: "x" }]);
      expect(res.status).toBe(400);
      const data = await readJson<ErrorResponse>(res);
      expect(data.details).toBeDefined();
    });

    it("400 quando array excede 1000 items", async () => {
      const jobs = Array.from({ length: 1001 }, (_, i) => makeDeleteMessageJob(`job-${i}`));
      const res = await postTasks(baseUrl, jobs);
      expect(res.status).toBe(400);
    });

    it("413 quando payload excede 2 MB", async () => {
      const largeBody = JSON.stringify({ pad: "a".repeat(2 * 1024 * 1024 + 128) });

      const res = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": VALID_API_KEY },
        body: largeBody,
      });

      expect(res.status).toBe(413);
      const data = await readJson<ErrorResponse>(res);
      expect(data.error).toBe("Payload too large");
    });
  });

  describe("happy path", () => {
    it("202 e publica cada job na fila AMQP para batch válido", async () => {
      publisher.send.mockClear();
      const jobs = [makeDeleteMessageJob("hp-1"), makeDeleteMessageJob("hp-2")];

      const res = await postTasks(baseUrl, jobs);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(2);
      expect(publisher.send).toHaveBeenCalledTimes(2);
    });

    it("202 para batch com um único job", async () => {
      publisher.send.mockClear();

      const res = await postTasks(baseUrl, [makeDeleteMessageJob()]);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(1);
      expect(publisher.send).toHaveBeenCalledTimes(1);
    });

    it("202 para batch misto (delete_message + remove_participant)", async () => {
      publisher.send.mockClear();
      const jobs = [makeDeleteMessageJob("mix-1"), makeRemoveParticipantJob("mix-2")];

      const res = await postTasks(baseUrl, jobs);

      expect(res.status).toBe(202);
      const data = await readJson<AcceptedResponse>(res);
      expect(data.accepted).toBe(2);
    });

    it("publica cada job na fila correta com deliveryMode persistente", async () => {
      publisher.send.mockClear();
      const job = makeDeleteMessageJob("persist-1");

      await postTasks(baseUrl, [job]);

      expect(publisher.send).toHaveBeenCalledTimes(1);

      const firstCall = publisher.send.mock.calls[0];
      expect(firstCall).toBeDefined();
      if (!firstCall) throw new Error("send should have at least one call");

      const [envelope, body] = firstCall;
      expect(envelope).toEqual({ routingKey: "test-queue", durable: true });
      expect(body).toEqual(job);
    });
  });
});

describe("GET /health", () => {
  it("200 sem exigir autenticação", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await readJson<HealthResponse>(res);
    expect(data.status).toBe("ok");
  });

  it("200 mesmo com api key inválida", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-api-key": "wrong" },
    });
    expect(res.status).toBe(200);
  });
});

describe("rotas inválidas", () => {
  it("404 para GET /tasks", async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      headers: { "x-api-key": VALID_API_KEY },
    });
    expect(res.status).toBe(404);
  });

  it("404 para POST /unknown", async () => {
    const res = await fetch(`${baseUrl}/unknown`, {
      method: "POST",
      headers: { "x-api-key": VALID_API_KEY },
    });
    expect(res.status).toBe(404);
  });

  it("404 para DELETE /tasks", async () => {
    const res = await fetch(`${baseUrl}/tasks`, {
      method: "DELETE",
      headers: { "x-api-key": VALID_API_KEY },
    });
    expect(res.status).toBe(404);
  });
});
