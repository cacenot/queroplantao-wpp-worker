import { randomUUID } from "node:crypto";
import { Connection } from "rabbitmq-client";
import { declareQueueTopology, type QueueTopology } from "../lib/retry-topology.ts";

/**
 * Cria uma conexão com o broker e declara uma topology isolada por teste,
 * com nomes de fila prefixados por UUID. Retorna a conexão, a topology e um
 * `cleanup()` que deleta as filas criadas e fecha a conexão.
 *
 * Usa TTL curto por padrão (200ms) para testes de end-to-end de TTL+DLX.
 */
export async function createTestTopology(
  overrides: { retryDelayMs?: number; maxRetries?: number; priority?: number } = {}
): Promise<{
  rabbit: Connection;
  topology: QueueTopology;
  cleanup: () => Promise<void>;
}> {
  const amqpUrl = process.env.AMQP_URL;
  if (!amqpUrl) {
    throw new Error("AMQP_URL é obrigatória para testes de integração (ver docker-compose.yml)");
  }

  const prefix = `test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const mainQueue = `${prefix}.main`;
  const retryDelayMs = overrides.retryDelayMs ?? 200;
  const maxRetries = overrides.maxRetries ?? 3;

  const rabbit = new Connection(amqpUrl);

  const topology = await declareQueueTopology(rabbit, {
    mainQueue,
    retryDelayMs,
    maxRetries,
    priority: overrides.priority,
  });

  return {
    rabbit,
    topology,
    async cleanup() {
      try {
        await rabbit.queueDelete(topology.mainQueue).catch(() => {});
        await rabbit.queueDelete(topology.retryQueue).catch(() => {});
        await rabbit.queueDelete(topology.dlqName).catch(() => {});
      } finally {
        await rabbit.close();
      }
    },
  };
}
