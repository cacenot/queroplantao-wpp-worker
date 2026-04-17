import { describe, expect, it, mock } from "bun:test";

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
process.env.AMQP_RETRY_DELAY_MS ??= "5000";
process.env.AMQP_RETRY_MAX_RETRIES ??= "2";

const { declareRetryTopology } = await import("./retry-topology.ts");

import type { Connection } from "rabbitmq-client";

interface DeclareCall {
  queue: string;
  durable?: boolean;
  arguments?: Record<string, unknown>;
}

function makeRabbit() {
  const calls: DeclareCall[] = [];
  const queueDeclare = mock((opts: DeclareCall) => {
    calls.push(opts);
    return Promise.resolve();
  });
  return {
    rabbit: { queueDeclare } as unknown as Connection,
    calls,
    queueDeclare,
  };
}

describe("declareRetryTopology", () => {
  it("declara main, retry e dlq com args corretos", async () => {
    const { rabbit, calls } = makeRabbit();

    const topology = await declareRetryTopology(rabbit);

    expect(calls).toHaveLength(3);

    const main = calls[0];
    expect(main?.queue).toBe("wpp.actions");
    expect(main?.durable).toBe(true);
    expect(main?.arguments).toBeUndefined();

    const retry = calls[1];
    expect(retry?.queue).toBe("wpp.actions.retry");
    expect(retry?.durable).toBe(true);
    expect(retry?.arguments).toEqual({
      "x-message-ttl": 5000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": "wpp.actions",
    });

    const dlq = calls[2];
    expect(dlq?.queue).toBe("wpp.actions.dlq");
    expect(dlq?.durable).toBe(true);
    expect(dlq?.arguments).toBeUndefined();

    expect(topology).toEqual({
      mainQueue: "wpp.actions",
      retryQueue: "wpp.actions.retry",
      dlqName: "wpp.actions.dlq",
      retryDelayMs: 5000,
      maxRetries: 2,
    });
  });
});
