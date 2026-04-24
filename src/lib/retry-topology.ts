import { AMQPChannelError, type Cmd, type Connection, type MethodParams } from "rabbitmq-client";
import { logger } from "./logger.ts";

type QueueDeclareParams = MethodParams[Cmd.QueueDeclare];

/**
 * Declara a fila se não existe; se já existe com args divergentes (PRECONDITION_FAILED),
 * faz passive verify (só confere existência pelo nome) e loga warning. Evita crash
 * loop quando o broker tem uma fila de versão anterior com args diferentes.
 */
async function declareOrVerify(rabbit: Connection, opts: QueueDeclareParams): Promise<void> {
  try {
    await rabbit.queueDeclare(opts);
  } catch (err) {
    if (!(err instanceof AMQPChannelError) || err.code !== "PRECONDITION_FAILED") throw err;
    logger.warn(
      { queue: opts.queue, expectedArgs: opts.arguments, expectedDurable: opts.durable },
      "Fila existe com args divergentes do esperado — usando fila existente (passive verify)"
    );
    await rabbit.queueDeclare({ queue: opts.queue, passive: true });
  }
}

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

  await declareOrVerify(rabbit, {
    queue: mainQueue,
    durable: true,
    arguments: priorityArgs,
  });

  await declareOrVerify(rabbit, {
    queue: retryQueue,
    durable: true,
    arguments: {
      ...(priorityArgs ?? {}),
      "x-message-ttl": retryDelayMs,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": mainQueue,
    },
  });

  await declareOrVerify(rabbit, {
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
