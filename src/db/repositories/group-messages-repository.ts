import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
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

  async upsertByIngestionHash(
    message: NewGroupMessage,
    zapiRow: NewGroupMessageZapi | null
  ): Promise<UpsertGroupMessageResult> {
    const [result] = await this.db
      .insert(groupMessages)
      .values(message)
      .onConflictDoUpdate({
        target: groupMessages.ingestionDedupeHash,
        set: { lastSeenAt: sql`now()`, updatedAt: sql`now()` },
      })
      .returning({
        ...getTableColumns(groupMessages),
        isNew: sql<boolean>`(xmax::text::int = 0)`,
      });

    if (!result) throw new Error("INSERT group_messages não retornou linha");

    if (result.isNew && zapiRow) {
      await this.db
        .insert(groupMessagesZapi)
        .values({ ...zapiRow, groupMessageId: result.id })
        .onConflictDoNothing({ target: groupMessagesZapi.groupMessageId });
    }

    const { isNew, ...row } = result;
    return { row: row as GroupMessage, isNew };
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

  async markRemoved(externalMessageId: string, groupExternalId: string): Promise<number> {
    const updated = await this.db
      .update(groupMessages)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(groupMessages.externalMessageId, externalMessageId),
          eq(groupMessages.groupExternalId, groupExternalId),
          isNull(groupMessages.removedAt)
        )
      )
      .returning({ id: groupMessages.id });
    return updated.length;
  }
}
