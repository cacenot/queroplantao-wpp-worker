import type { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { logger } from "./logger.ts";

export interface RetryTopology {
  mainQueue: string;
  retryQueue: string;
  dlqName: string;
  retryDelayMs: number;
  maxRetries: number;
}

/**
 * Declara a fila principal, a fila de retry (TTL+DLX) e a DLQ no broker.
 *
 * Padrão TTL+DLX:
 *   - A fila de retry tem x-message-ttl e x-dead-letter-routing-key → mainQueue
 *   - Após o TTL a mensagem é entregue de volta à fila principal automaticamente
 *   - DLQ é uma fila durável comum, sem consumer — para inspeção manual
 *
 * Mudar AMQP_RETRY_DELAY_MS em ambiente com a fila de retry já declarada dispara
 * PRECONDITION_FAILED. Para alterar o TTL em produção, delete a fila no broker
 * antes do deploy ou versione o nome (ex.: ${mainQueue}.retry.v2).
 */
export async function declareRetryTopology(rabbit: Connection): Promise<RetryTopology> {
  const mainQueue = env.AMQP_QUEUE;
  const retryDelayMs = env.AMQP_RETRY_DELAY_MS;
  const maxRetries = env.AMQP_RETRY_MAX_RETRIES;
  const dlqName = env.AMQP_DLQ_NAME ?? `${mainQueue}.dlq`;
  const retryQueue = `${mainQueue}.retry`;

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

  logger.info(
    { mainQueue, retryQueue, dlqName, retryDelayMs, maxRetries },
    "Retry topology declarada"
  );

  return { mainQueue, retryQueue, dlqName, retryDelayMs, maxRetries };
}
