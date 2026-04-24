import { env } from "../config/env.ts";
import type { JobSchema } from "./schemas.ts";

export type JobType = JobSchema["type"];

/**
 * Mapeia cada tipo de job pra sua fila principal.
 *
 * - delete_message/remove_participant → AMQP_ZAPI_QUEUE (uma fila só, priority separa)
 * - moderate_group_message/ingest_participant_event → AMQP_MODERATION_QUEUE (paralelismo ok, sem priority)
 *
 * NOTA — `ingest_participant_event` na fila de moderação: decisão pragmática. Esse
 * job só toca DB (zero Z-API), então reaproveitar o prefetch=5 do moderation-worker
 * é mais barato que subir um terceiro processo hoje. Quando adicionarmos webhooks
 * de outros providers (WhatsMeow, Business API, Telegram), vale separar um
 * `wpp.ingestion` dedicado — aí o worker de moderation volta a ter escopo fechado.
 */
export function queueForJob(type: JobType): string {
  switch (type) {
    case "whatsapp.delete_message":
    case "whatsapp.remove_participant":
      return env.AMQP_ZAPI_QUEUE;
    case "whatsapp.moderate_group_message":
    case "whatsapp.ingest_participant_event":
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
    case "whatsapp.ingest_participant_event":
      return undefined;
  }
}

export function retryQueueForJob(type: JobType): string {
  return `${queueForJob(type)}.retry`;
}

export function dlqForJob(type: JobType): string {
  return `${queueForJob(type)}.dlq`;
}
