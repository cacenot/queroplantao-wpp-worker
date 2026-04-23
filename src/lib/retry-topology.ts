import type { Connection } from "rabbitmq-client";
import { logger } from "./logger.ts";

export type QueueTopology = {
  mainQueue: string;
  retryQueue: string;
  dlqName: string;
  retryDelayMs: number;
  maxRetries: number;
  priority?: number;
};

export type DeclareQueueTopologyOptions = {
  mainQueue: string;
  retryDelayMs: number;
  maxRetries: number;
  priority?: number;
};

/**
 * Declara a fila principal, a fila de retry (TTL+DLX) e a DLQ no broker.
 *
 * Padrão TTL+DLX:
 *   - A fila de retry tem x-message-ttl e x-dead-letter-routing-key → mainQueue
 *   - Após o TTL a mensagem é entregue de volta à fila principal automaticamente
 *   - DLQ é uma fila durável comum, sem consumer — para inspeção manual
 *
 * Prioridade:
 *   - Se `priority` for informada, as três filas são declaradas com x-max-priority=priority.
 *   - LavinMQ/RabbitMQ exige `x-max-priority` uniforme nas três filas do ciclo pra não
 *     disparar PRECONDITION_FAILED ao re-entregar via DLX.
 *
 * Mudar TTL/priority em fila já declarada dispara PRECONDITION_FAILED. Para alterar em
 * produção, delete a fila no broker antes do deploy ou versione o nome (ex.: .retry.v2).
 */
export async function declareQueueTopology(
  rabbit: Connection,
  opts: DeclareQueueTopologyOptions
): Promise<QueueTopology> {
  const { mainQueue, retryDelayMs, maxRetries, priority } = opts;
  const retryQueue = `${mainQueue}.retry`;
  const dlqName = `${mainQueue}.dlq`;

  const priorityArgs = priority ? { "x-max-priority": priority } : undefined;

  await rabbit.queueDeclare({
    queue: mainQueue,
    durable: true,
    arguments: priorityArgs,
  });

  await rabbit.queueDeclare({
    queue: retryQueue,
    durable: true,
    arguments: {
      ...(priorityArgs ?? {}),
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": mainQueue,
    },
  });

  await rabbit.queueDeclare({
    queue: dlqName,
    durable: true,
    arguments: priorityArgs,
  });

  logger.info(
    { mainQueue, retryQueue, dlqName, retryDelayMs, maxRetries, priority },
    "Queue topology declarada"
  );

  return { mainQueue, retryQueue, dlqName, retryDelayMs, maxRetries, priority };
}
