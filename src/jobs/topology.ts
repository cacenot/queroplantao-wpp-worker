import type { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { declareQueueTopology, type QueueTopology } from "../lib/retry-topology.ts";

export type JobTopologies = {
  zapi: QueueTopology;
  moderation: QueueTopology;
};

/**
 * Declara as topologies de TODAS as filas de job (zapi + moderation) no broker.
 *
 * Chamado por ambos os workers no boot e também pela API — `queueDeclare` é
 * idempotente com os mesmos args, então re-declarar é seguro. Garantir que a API
 * também declare fecha a janela de corrida onde a API publicaria antes do
 * primeiro worker subir (mensagem iria pro default exchange e seria silenciosamente
 * dropada).
 *
 * Mantém args alinhados com `priorityForJob` em `./routing.ts`.
 */
export async function declareJobTopologies(rabbit: Connection): Promise<JobTopologies> {
  const zapi = await declareQueueTopology(rabbit, {
    mainQueue: env.AMQP_ZAPI_QUEUE,
    retryDelayMs: env.AMQP_RETRY_DELAY_MS,
    maxRetries: env.AMQP_RETRY_MAX_RETRIES,
    priority: 10,
  });

  const moderation = await declareQueueTopology(rabbit, {
    mainQueue: env.AMQP_MODERATION_QUEUE,
    retryDelayMs: env.AMQP_RETRY_DELAY_MS,
    maxRetries: env.AMQP_RETRY_MAX_RETRIES,
  });

  return { zapi, moderation };
}
