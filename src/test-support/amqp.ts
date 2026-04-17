import { randomUUID } from "node:crypto";
import { Connection } from "rabbitmq-client";
import type { RetryTopology } from "../lib/retry-topology.ts";

/**
 * Cria uma conexão com o broker e declara uma topology de retry isolada por teste,
 * com nomes de fila prefixados por UUID. Retorna a conexão, a topology e um
 * `cleanup()` que deleta as filas criadas e fecha a conexão.
 *
 * Usa TTL curto por padrão (200ms) para testes de end-to-end de TTL+DLX.
 */
export async function createTestTopology(
  overrides: { retryDelayMs?: number; maxRetries?: number } = {}
): Promise<{
  rabbit: Connection;
  topology: RetryTopology;
  cleanup: () => Promise<void>;
}> {
  const amqpUrl = process.env.AMQP_URL;
  if (!amqpUrl) {
    throw new Error("AMQP_URL é obrigatória para testes de integração (ver docker-compose.yml)");
  }

  const prefix = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const mainQueue = `${prefix}.main`;
  const retryQueue = `${prefix}.retry`;
  const dlqName = `${prefix}.dlq`;
  const retryDelayMs = overrides.retryDelayMs ?? 200;
  const maxRetries = overrides.maxRetries ?? 3;

  const rabbit = new Connection(amqpUrl);

  await rabbit.queueDeclare({ queue: mainQueue, durable: true });
  await rabbit.queueDeclare({
    queue: retryQueue,
    durable: true,
    arguments: {
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": mainQueue,
    },
  });
  await rabbit.queueDeclare({ queue: dlqName, durable: true });

  const topology: RetryTopology = {
    mainQueue,
    retryQueue,
    dlqName,
    retryDelayMs,
    maxRetries,
  };

  return {
    rabbit,
    topology,
    async cleanup() {
      try {
        await rabbit.queueDelete(mainQueue).catch(() => {});
        await rabbit.queueDelete(retryQueue).catch(() => {});
        await rabbit.queueDelete(dlqName).catch(() => {});
      } finally {
        await rabbit.close();
      }
    },
  };
}
