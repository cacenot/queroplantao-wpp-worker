import { env } from "../config/env.ts";
import type { JobSchema } from "./schemas.ts";

export type JobType = JobSchema["type"];

/**
 * Mapeia cada tipo de job pra sua fila principal.
 *
 * - delete_message/remove_participant → AMQP_ZAPI_QUEUE (uma fila só, priority separa)
 * - moderate_group_message → AMQP_MODERATION_QUEUE (paralelismo ok, sem priority)
 */
export function queueForJob(type: JobType): string {
  switch (type) {
    case "whatsapp.delete_message":
    case "whatsapp.remove_participant":
      return env.AMQP_ZAPI_QUEUE;
    case "whatsapp.moderate_group_message":
      return env.AMQP_MODERATION_QUEUE;
  }
}

/**
 * Priority dentro da fila zapi: delete (10) antes de remove (7). Se delete falhar,
 * mensagem ainda é visível; re-removido sozinho é inofensivo.
 *
 * `undefined` em filas sem `x-max-priority` — passar 0/undefined é equivalente a
 * nenhuma priority pro broker.
 */
export function priorityForJob(type: JobType): number | undefined {
  switch (type) {
    case "whatsapp.delete_message":
      return 10;
    case "whatsapp.remove_participant":
      return 7;
    case "whatsapp.moderate_group_message":
      return undefined;
  }
}

export function retryQueueForJob(type: JobType): string {
  return `${queueForJob(type)}.retry`;
}

export function dlqForJob(type: JobType): string {
  return `${queueForJob(type)}.dlq`;
}
