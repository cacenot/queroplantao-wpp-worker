import { and, desc, eq, gt } from "drizzle-orm";
import type { Db } from "../client.ts";
import type { GroupMessage } from "../schema/group-messages.ts";
import { groupMessages } from "../schema/group-messages.ts";
import {
  type MessageModeration,
  messageModerations,
  type NewMessageModeration,
} from "../schema/message-moderations.ts";

export interface MessageWithModeration {
  message: GroupMessage;
  moderation: MessageModeration;
}

export class MessageModerationsRepository {
  constructor(private readonly db: Db) {}

  async create(row: NewMessageModeration): Promise<MessageModeration> {
    const [inserted] = await this.db.insert(messageModerations).values(row).returning();
    if (!inserted) throw new Error("INSERT message_moderations não retornou linha");
    return inserted;
  }

  /**
   * Busca a moderação mais recente com o mesmo contentHash + version
   * analisada dentro da janela. Usada para reusar resultado sem nova análise.
   */
  async findReusable(
    contentHash: string,
    moderationVersion: string,
    cutoff: Date
  ): Promise<MessageModeration | null> {
    const [row] = await this.db
      .select()
      .from(messageModerations)
      .where(
        and(
          eq(messageModerations.contentHash, contentHash),
          eq(messageModerations.moderationVersion, moderationVersion),
          eq(messageModerations.status, "analyzed"),
          eq(messageModerations.source, "fresh"),
          gt(messageModerations.createdAt, cutoff)
        )
      )
      .orderBy(desc(messageModerations.createdAt))
      .limit(1);
    return row ?? null;
  }

  async findByIdWithMessage(id: string): Promise<MessageWithModeration | null> {
    const [row] = await this.db
      .select({ moderation: messageModerations, message: groupMessages })
      .from(messageModerations)
      .innerJoin(groupMessages, eq(messageModerations.groupMessageId, groupMessages.id))
      .where(eq(messageModerations.id, id))
      .limit(1);
    return row ?? null;
  }

  async markAnalyzed(
    id: string,
    fields: {
      reason: string | null;
      partner: string | null;
      category: string | null;
      confidence: number | null;
      action: string | null;
      rawResult: Record<string, unknown> | null;
      promptTokens: number | null;
      completionTokens: number | null;
      latencyMs: number | null;
    }
  ): Promise<void> {
    await this.db
      .update(messageModerations)
      .set({
        status: "analyzed",
        reason: fields.reason,
        partner: fields.partner,
        category: fields.category,
        confidence: fields.confidence !== null ? fields.confidence.toString() : null,
        action: fields.action,
        rawResult: fields.rawResult ?? undefined,
        promptTokens: fields.promptTokens,
        completionTokens: fields.completionTokens,
        latencyMs: fields.latencyMs,
        completedAt: new Date(),
      })
      .where(eq(messageModerations.id, id));
  }

  async markFailed(
    id: string,
    error: { message: string; name?: string; stack?: string },
    latencyMs: number | null
  ): Promise<void> {
    await this.db
      .update(messageModerations)
      .set({
        status: "failed",
        error,
        latencyMs,
        completedAt: new Date(),
      })
      .where(eq(messageModerations.id, id));
  }

  async findById(id: string): Promise<MessageModeration | null> {
    const [row] = await this.db
      .select()
      .from(messageModerations)
      .where(eq(messageModerations.id, id))
      .limit(1);
    return row ?? null;
  }
}
