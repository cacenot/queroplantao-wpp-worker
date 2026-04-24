import { relations, sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { groupParticipants } from "./group-participants.ts";
import { messagingProtocolEnum, messagingProviderKindEnum } from "./provider-registry.ts";

export const groupParticipantEventTypeEnum = pgEnum("group_participant_event_type", [
  "joined_add",
  "joined_invite_link",
  "joined_non_admin_add",
  "joined_inferred",
  "left_removed",
  "left_voluntary",
  "promoted_admin",
  "demoted_member",
]);

export const groupParticipantEvents = pgTable(
  "group_participant_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    groupParticipantId: uuid("group_participant_id").references(() => groupParticipants.id, {
      onDelete: "set null",
    }),
    groupExternalId: text("group_external_id").notNull(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    providerKind: messagingProviderKindEnum("provider_kind").notNull(),

    eventType: groupParticipantEventTypeEnum("event_type").notNull(),

    targetPhone: text("target_phone"),
    targetSenderExternalId: text("target_sender_external_id"),
    targetWaId: text("target_wa_id"),

    actorPhone: text("actor_phone"),
    actorSenderExternalId: text("actor_sender_external_id"),

    sourceWebhookMessageId: text("source_webhook_message_id"),
    sourceNotification: text("source_notification"),
    rawPayload: jsonb("raw_payload").$type<unknown>(),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Dedupe: mesmo webhook + mesmo tipo + mesmo alvo é idempotente. Campos-chave
    // que podem ser null são coalescidos para string vazia — senão postgres trata
    // NULLs como distintos em UNIQUE e quebra a idempotência.
    dedupeIdx: uniqueIndex("group_participant_events_dedupe_idx").on(
      sql`COALESCE(${table.sourceWebhookMessageId}, '')`,
      table.eventType,
      sql`COALESCE(${table.targetPhone}, '')`,
      sql`COALESCE(${table.targetSenderExternalId}, '')`
    ),
    groupOccurredAtIdx: index("group_participant_events_group_occurred_at_idx").on(
      table.groupExternalId,
      table.occurredAt
    ),
    participantIdx: index("group_participant_events_participant_idx").on(table.groupParticipantId),
  })
);

export const groupParticipantEventsRelations = relations(groupParticipantEvents, ({ one }) => ({
  groupParticipant: one(groupParticipants, {
    fields: [groupParticipantEvents.groupParticipantId],
    references: [groupParticipants.id],
  }),
}));

export type GroupParticipantEvent = typeof groupParticipantEvents.$inferSelect;
export type NewGroupParticipantEvent = typeof groupParticipantEvents.$inferInsert;
export type GroupParticipantEventType = (typeof groupParticipantEventTypeEnum.enumValues)[number];
