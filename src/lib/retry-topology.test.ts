import { describe, expect, it, mock } from "bun:test";

// env é parseado no primeiro load e congelado. HTTP_API_KEY é sobrescrito unconditionally
// para bater com VALID_API_KEY dos testes de rota HTTP (que rodam no mesmo processo).
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY = "test-api-key-secret";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.AMQP_RETRY_DELAY_MS ??= "5000";
process.env.AMQP_RETRY_MAX_RETRIES ??= "2";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";

const { declareQueueTopology } = await import("./retry-topology.ts");

import { AMQPChannelError, type Connection } from "rabbitmq-client";

// O `.d.ts` da lib só expõe o construtor herdado de Error. O real em `exception.js`
// é `constructor(code, message, cause)`. Cast explícito para usar a assinatura real.
type AMQPChannelErrorCtor = new (code: string, message: string) => AMQPChannelError;
const AMQPChannelErrorC = AMQPChannelError as unknown as AMQPChannelErrorCtor;

interface DeclareCall {
  queue: string;
  durable?: boolean;
  arguments?: Record<string, unknown>;
  passive?: boolean;
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

describe("declareQueueTopology", () => {
  it("declara main, retry e dlq sem priority", async () => {
    const { rabbit, calls } = makeRabbit();

    const topology = await declareQueueTopology(rabbit, {
      mainQueue: "messaging.moderation",
      retryDelayMs: 5000,
      maxRetries: 2,
    });

    expect(calls).toHaveLength(3);

    const main = calls[0];
    expect(main?.queue).toBe("messaging.moderation");
    expect(main?.durable).toBe(true);
    expect(main?.arguments).toBeUndefined();

    const retry = calls[1];
    expect(retry?.queue).toBe("messaging.moderation.retry");
    expect(retry?.durable).toBe(true);
    expect(retry?.arguments).toEqual({
      "x-message-ttl": 5000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": "messaging.moderation",
    });

    const dlq = calls[2];
    expect(dlq?.queue).toBe("messaging.moderation.dlq");
    expect(dlq?.durable).toBe(true);
    expect(dlq?.arguments).toBeUndefined();

    expect(topology.retryQueue).toBe("messaging.moderation.retry");
    expect(topology.dlqName).toBe("messaging.moderation.dlq");
    expect(topology.priority).toBeUndefined();
  });

  it("propaga x-max-priority pras três filas quando priority informada", async () => {
    const { rabbit, calls } = makeRabbit();

    const topology = await declareQueueTopology(rabbit, {
      mainQueue: "messaging.zapi",
      retryDelayMs: 5000,
      maxRetries: 2,
      priority: 10,
    });

    expect(calls).toHaveLength(3);

    expect(calls[0]?.arguments).toEqual({ "x-max-priority": 10 });
    expect(calls[1]?.arguments).toEqual({
      "x-max-priority": 10,
      "x-message-ttl": 5000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": "messaging.zapi",
    });
    expect(calls[2]?.arguments).toEqual({ "x-max-priority": 10 });
    expect(topology.priority).toBe(10);
  });

  it("cai para passive verify quando broker responde PRECONDITION_FAILED", async () => {
    const calls: DeclareCall[] = [];
    const queueDeclare = mock((opts: DeclareCall) => {
      calls.push(opts);
      if (opts.queue === "messaging.zapi" && !opts.passive) {
        const err = new AMQPChannelErrorC(
          "PRECONDITION_FAILED",
          "Existing queue 'messaging.zapi' declared with other arguments"
        );
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
    const rabbit = { queueDeclare } as unknown as Connection;

    await expect(
      declareQueueTopology(rabbit, {
        mainQueue: "messaging.zapi",
        retryDelayMs: 5000,
        maxRetries: 2,
        priority: 10,
      })
    ).resolves.toBeDefined();

    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ queue: "messaging.zapi", durable: true });
    expect(calls[1]).toEqual({ queue: "messaging.zapi", passive: true });
    expect(calls[2]).toMatchObject({ queue: "messaging.zapi.retry", durable: true });
    expect(calls[3]).toMatchObject({ queue: "messaging.zapi.dlq", durable: true });
  });

  it("propaga erro que não é PRECONDITION_FAILED", async () => {
    const queueDeclare = mock((_opts: DeclareCall) => {
      const err = new AMQPChannelErrorC("ACCESS_REFUSED", "no permission");
      return Promise.reject(err);
    });
    const rabbit = { queueDeclare } as unknown as Connection;

    await expect(
      declareQueueTopology(rabbit, {
        mainQueue: "messaging.zapi",
        retryDelayMs: 5000,
        maxRetries: 2,
      })
    ).rejects.toMatchObject({ code: "ACCESS_REFUSED" });
  });
});
