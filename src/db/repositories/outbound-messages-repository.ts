import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type NewOutboundMessage,
  type OutboundMessage,
  outboundMessages,
} from "../schema/outbound-messages.ts";

export class OutboundMessagesRepository {
  constructor(private readonly db: Db) {}

  async create(row: NewOutboundMessage): Promise<OutboundMessage> {
    const [created] = await this.db.insert(outboundMessages).values(row).returning();
    if (!created) {
      throw new Error("INSERT em outbound_messages não retornou linha");
    }
    return created;
  }

  async findById(id: string): Promise<OutboundMessage | null> {
    const [row] = await this.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<OutboundMessage | null> {
    const [row] = await this.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.idempotencyKey, key))
      .limit(1);
    return row ?? null;
  }

  // task_id é vínculo de FK — sempre grava. A transição para `queued` só dispara
  // se o status ainda for `pending` (caso o worker tenha drenado a fila e movido
  // para `sending` antes deste UPDATE, o status corrente é preservado).
  // Ver convenção "UPDATEs condicionais a status" em CLAUDE.md e o débito em
  // docs/follow-ups/setTaskId-transactional-fix.md (refactor proposto).
  async setTaskId(id: string, taskId: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({
        taskId,
        status: sql`CASE WHEN ${outboundMessages.status} = 'pending' THEN 'queued'::outbound_message_status ELSE ${outboundMessages.status} END`,
        queuedAt: sql`COALESCE(${outboundMessages.queuedAt}, NOW())`,
        updatedAt: new Date(),
      })
      .where(eq(outboundMessages.id, id));
  }

  // Incrementa attempt e marca como sending. Aceita partir de pending/queued
  // (primeira execução) ou sending (retry depois de falha transitória).
  async markSending(id: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({
        status: "sending",
        attempt: sql`${outboundMessages.attempt} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outboundMessages.id, id),
          inArray(outboundMessages.status, ["pending", "queued", "sending"])
        )
      );
  }

  async markSent(id: string, externalMessageId: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({
        status: "sent",
        externalMessageId,
        sentAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(outboundMessages.id, id));
  }

  // `WHERE status NOT IN ('failed', 'sent')` — single-writer principle: o primeiro
  // a marcar terminal vence; segundas chamadas (ex.: onTerminalFailure após a
  // action já ter marcado em 4xx) viram no-op em vez de sobrescrever contexto rico.
  async markFailed(
    id: string,
    error: {
      message: string;
      name?: string;
      stack?: string;
      status?: number;
      body?: unknown;
    }
  ): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({ status: "failed", error, failedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(outboundMessages.id, id), notInArray(outboundMessages.status, ["failed", "sent"]))
      );
  }

  async markDropped(id: string, reason: string): Promise<void> {
    await this.db
      .update(outboundMessages)
      .set({
        status: "dropped",
        error: { message: reason },
        failedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outboundMessages.id, id));
  }

  // Útil para reaper futuro: marcar pending órfãos antigos.
  async countByStatus(status: OutboundMessage["status"]): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboundMessages)
      .where(eq(outboundMessages.status, status));
    return row?.count ?? 0;
  }
}
