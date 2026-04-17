import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { groupMessages } from "./group-messages.ts";
import {
  messageModerationSourceEnum,
  messageModerationStatusEnum,
} from "./message-moderation-enums.ts";

export const messageModerations = pgTable(
  "message_moderations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupMessageId: uuid("group_message_id")
      .notNull()
      .references((): AnyPgColumn => groupMessages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    moderationVersion: text("moderation_version").notNull(),
    model: text("model").notNull(),
    source: messageModerationSourceEnum("source").notNull(),
    sourceModerationId: uuid("source_moderation_id").references(
      (): AnyPgColumn => messageModerations.id,
      { onDelete: "set null" }
    ),
    status: messageModerationStatusEnum("status").notNull().default("pending"),
    reason: text("reason"),
    partner: text("partner"),
    category: text("category"),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    action: text("action"),
    rawResult: jsonb("raw_result").$type<Record<string, unknown>>(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    latencyMs: integer("latency_ms"),
    error: jsonb("error").$type<{ message: string; name?: string; stack?: string } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    groupMessageVersionIdx: uniqueIndex("message_moderations_group_message_version_idx").on(
      table.groupMessageId,
      table.moderationVersion
    ),
    reuseLookupIdx: index("message_moderations_reuse_lookup_idx").on(
      table.contentHash,
      table.moderationVersion,
      table.status,
      table.createdAt
    ),
    categoryCreatedIdx: index("message_moderations_category_created_at_idx").on(
      table.category,
      table.createdAt
    ),
    actionCreatedIdx: index("message_moderations_action_created_at_idx").on(
      table.action,
      table.createdAt
    ),
  })
);

export const messageModerationsRelations = relations(messageModerations, ({ one }) => ({
  groupMessage: one(groupMessages, {
    fields: [messageModerations.groupMessageId],
    references: [groupMessages.id],
  }),
  sourceModeration: one(messageModerations, {
    fields: [messageModerations.sourceModerationId],
    references: [messageModerations.id],
    relationName: "message_moderation_source",
  }),
}));

export type MessageModeration = typeof messageModerations.$inferSelect;
export type NewMessageModeration = typeof messageModerations.$inferInsert;
