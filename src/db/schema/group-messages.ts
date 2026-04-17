import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { messageModerationStatusEnum } from "./message-moderation-enums.ts";
import { messageModerations } from "./message-moderations.ts";
import { messagingGroups } from "./messaging-groups.ts";
import {
  messagingProtocolEnum,
  messagingProviderInstances,
  messagingProviderKindEnum,
} from "./provider-registry.ts";

export {
  messageModerationSourceEnum,
  messageModerationStatusEnum,
} from "./message-moderation-enums.ts";

export const groupMessages = pgTable(
  "group_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ingestionDedupeHash: text("ingestion_dedupe_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    providerKind: messagingProviderKindEnum("provider_kind").notNull(),
    providerInstanceId: uuid("provider_instance_id").references(
      () => messagingProviderInstances.id,
      { onDelete: "set null" }
    ),
    groupExternalId: text("group_external_id").notNull(),
    messagingGroupId: uuid("messaging_group_id").references(() => messagingGroups.id, {
      onDelete: "set null",
    }),
    senderPhone: text("sender_phone"),
    senderExternalId: text("sender_external_id"),
    senderName: text("sender_name"),
    externalMessageId: text("external_message_id").notNull(),
    referenceExternalMessageId: text("reference_external_message_id"),
    messageType: text("message_type").notNull(),
    messageSubtype: text("message_subtype"),
    hasText: boolean("has_text").notNull(),
    normalizedText: text("normalized_text"),
    mediaUrl: text("media_url"),
    thumbnailUrl: text("thumbnail_url"),
    mimeType: text("mime_type"),
    caption: text("caption"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    fromMe: boolean("from_me").notNull().default(false),
    isForwarded: boolean("is_forwarded").notNull().default(false),
    isEdited: boolean("is_edited").notNull().default(false),
    moderationStatus: messageModerationStatusEnum("moderation_status").notNull().default("pending"),
    currentModerationId: uuid("current_moderation_id").references(
      (): AnyPgColumn => messageModerations.id,
      { onDelete: "set null" }
    ),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ingestionDedupeHashIdx: uniqueIndex("group_messages_ingestion_dedupe_hash_idx").on(
      table.ingestionDedupeHash
    ),
    contentHashIdx: index("group_messages_content_hash_idx").on(table.contentHash),
    groupProtocolSentAtIdx: index("group_messages_group_protocol_sent_at_idx").on(
      table.protocol,
      table.groupExternalId,
      table.sentAt
    ),
    moderationStatusIdx: index("group_messages_moderation_status_idx").on(
      table.moderationStatus,
      table.createdAt
    ),
  })
);

export const groupMessagesZapi = pgTable(
  "group_messages_zapi",
  {
    groupMessageId: uuid("group_message_id")
      .primaryKey()
      .references(() => groupMessages.id, { onDelete: "cascade" }),
    zapiInstanceExternalId: text("zapi_instance_external_id").notNull(),
    connectedPhone: text("connected_phone"),
    chatName: text("chat_name"),
    status: text("status"),
    senderLid: text("sender_lid"),
    waitingMessage: boolean("waiting_message"),
    viewOnce: boolean("view_once"),
    extractedPayload: jsonb("extracted_payload").$type<Record<string, unknown>>(),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    zapiInstanceExternalIdIdx: index("group_messages_zapi_instance_external_id_idx").on(
      table.zapiInstanceExternalId,
      table.receivedAt
    ),
  })
);

export const groupMessagesRelations = relations(groupMessages, ({ one, many }) => ({
  providerInstance: one(messagingProviderInstances, {
    fields: [groupMessages.providerInstanceId],
    references: [messagingProviderInstances.id],
  }),
  messagingGroup: one(messagingGroups, {
    fields: [groupMessages.messagingGroupId],
    references: [messagingGroups.id],
  }),
  currentModeration: one(messageModerations, {
    fields: [groupMessages.currentModerationId],
    references: [messageModerations.id],
  }),
  zapi: one(groupMessagesZapi, {
    fields: [groupMessages.id],
    references: [groupMessagesZapi.groupMessageId],
  }),
  moderations: many(messageModerations),
}));

export const groupMessagesZapiRelations = relations(groupMessagesZapi, ({ one }) => ({
  groupMessage: one(groupMessages, {
    fields: [groupMessagesZapi.groupMessageId],
    references: [groupMessages.id],
  }),
}));

export type GroupMessage = typeof groupMessages.$inferSelect;
export type NewGroupMessage = typeof groupMessages.$inferInsert;
export type GroupMessageZapi = typeof groupMessagesZapi.$inferSelect;
export type NewGroupMessageZapi = typeof groupMessagesZapi.$inferInsert;
