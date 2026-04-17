import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type GroupMessage,
  groupMessages,
  groupMessagesZapi,
  type NewGroupMessage,
  type NewGroupMessageZapi,
} from "../schema/group-messages.ts";
import type { messageModerationStatusEnum } from "../schema/message-moderation-enums.ts";

type ModerationStatus = (typeof messageModerationStatusEnum.enumValues)[number];

export interface UpsertGroupMessageResult {
  row: GroupMessage;
  isNew: boolean;
}

export class GroupMessagesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Idempotente: insere nova linha ou atualiza last_seen_at quando o
   * ingestion_dedupe_hash já existir (duplicata de outra instância).
   */
  async upsertByIngestionHash(
    message: NewGroupMessage,
    zapiRow: NewGroupMessageZapi | null
  ): Promise<UpsertGroupMessageResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(groupMessages)
        .where(eq(groupMessages.ingestionDedupeHash, message.ingestionDedupeHash))
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(groupMessages)
          .set({ lastSeenAt: new Date(), updatedAt: new Date() })
          .where(eq(groupMessages.id, existing.id))
          .returning();
        return { row: updated ?? existing, isNew: false };
      }

      const [inserted] = await tx.insert(groupMessages).values(message).returning();
      if (!inserted) throw new Error("INSERT group_messages não retornou linha");

      if (zapiRow) {
        await tx
          .insert(groupMessagesZapi)
          .values({ ...zapiRow, groupMessageId: inserted.id })
          .onConflictDoNothing({ target: groupMessagesZapi.groupMessageId });
      }

      return { row: inserted, isNew: true };
    });
  }

  async setCurrentModeration(
    messageId: string,
    moderationId: string,
    status: ModerationStatus
  ): Promise<void> {
    await this.db
      .update(groupMessages)
      .set({
        currentModerationId: moderationId,
        moderationStatus: status,
        updatedAt: new Date(),
      })
      .where(eq(groupMessages.id, messageId));
  }

  async setModerationStatus(messageId: string, status: ModerationStatus): Promise<void> {
    await this.db
      .update(groupMessages)
      .set({ moderationStatus: status, updatedAt: new Date() })
      .where(eq(groupMessages.id, messageId));
  }

  async findById(id: string): Promise<GroupMessage | null> {
    const [row] = await this.db
      .select()
      .from(groupMessages)
      .where(eq(groupMessages.id, id))
      .limit(1);
    return row ?? null;
  }

  async touchLastSeen(id: string): Promise<void> {
    await this.db
      .update(groupMessages)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(groupMessages.id, id));
  }
}
