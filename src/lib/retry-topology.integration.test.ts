import { afterAll, describe, expect, it } from "bun:test";
import { Connection } from "rabbitmq-client";

process.env.DATABASE_URL ??= "postgres://postgres:secret@localhost:5432/queroplantao_messaging";
process.env.AMQP_URL ??= "amqp://guest:guest@localhost:5672";
process.env.AMQP_QUEUE ??= "wpp.actions";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY ??= "test-key";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";

const { createTestTopology } = await import("../test-support/amqp.ts");

const INTEGRATION = process.env.INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("retry topology (integration, LavinMQ)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const c of cleanups) await c().catch(() => {});
  });

  it("declara main, retry e dlq sem erro", async () => {
    const t = await createTestTopology({ retryDelayMs: 200 });
    cleanups.push(t.cleanup);

    expect(t.topology.mainQueue).toMatch(/\.main$/);
    expect(t.topology.retryQueue).toMatch(/\.retry$/);
    expect(t.topology.dlqName).toMatch(/\.dlq$/);
  });

  it("end-to-end: publicar em retry → após TTL a mensagem aparece em main (via DLX)", async () => {
    const t = await createTestTopology({ retryDelayMs: 150 });
    cleanups.push(t.cleanup);

    const publisher = t.rabbit.createPublisher({ confirm: true });

    const body = { hello: "world", ts: Date.now() };
    await publisher.send({ routingKey: t.topology.retryQueue, durable: true }, body);

    const received = await waitForMessage(t.rabbit, t.topology.mainQueue, 5000);

    expect(received).toEqual(body);
    await publisher.close();
  });

  it("redeclarar com TTL diferente dispara PRECONDITION_FAILED", async () => {
    const t = await createTestTopology({ retryDelayMs: 100 });
    cleanups.push(t.cleanup);

    const other = new Connection(process.env.AMQP_URL as string);

    await expect(
      other.queueDeclare({
        queue: t.topology.retryQueue,
        durable: true,
        arguments: {
          "x-message-ttl": 999999,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": t.topology.mainQueue,
        },
      })
    ).rejects.toThrow();

    await other.close();
  });
});

async function waitForMessage(
  rabbit: Connection,
  queue: string,
  timeoutMs: number
): Promise<unknown> {
  // Resolve da Promise fica fora do handler: chamar consumer.close() dentro do
  // callback causa deadlock — o close aguarda o ack da mensagem atual, mas o ack
  // só é enviado quando o handler retorna.
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timeout = setTimeout(
    () => reject(new Error(`timeout aguardando mensagem em ${queue}`)),
    timeoutMs
  );

  const consumer = rabbit.createConsumer(
    { queue, queueOptions: { passive: true } },
    async (msg) => {
      resolve(msg.body);
    }
  );
  consumer.on("error", (err) => reject(err));

  try {
    return await promise;
  } finally {
    clearTimeout(timeout);
    await consumer.close().catch(() => {});
  }
}
