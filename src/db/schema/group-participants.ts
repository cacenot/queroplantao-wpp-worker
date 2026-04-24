import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { messagingGroups } from "./messaging-groups.ts";
import { messagingProtocolEnum, messagingProviderKindEnum } from "./provider-registry.ts";

export const groupParticipantRoleEnum = pgEnum("group_participant_role", [
  "member",
  "admin",
  "owner",
]);

export const groupParticipantStatusEnum = pgEnum("group_participant_status", ["active", "left"]);

export const groupParticipantLeaveReasonEnum = pgEnum("group_participant_leave_reason", [
  "removed_by_admin",
  "left_voluntarily",
  "manual_enforcement",
  "unknown",
]);

export const groupParticipants = pgTable(
  "group_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messagingGroupId: uuid("messaging_group_id").references(() => messagingGroups.id, {
      onDelete: "set null",
    }),
    groupExternalId: text("group_external_id").notNull(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    providerKind: messagingProviderKindEnum("provider_kind").notNull(),

    // Identidade — pelo menos um de phone, sender_external_id ou wa_id.
    phone: text("phone"),
    senderExternalId: text("sender_external_id"),
    waId: text("wa_id"),
    displayName: text("display_name"),

    // IDs externos da plataforma QP — preenchidos por job/script separado.
    userId: text("user_id"),
    professionalId: text("professional_id"),
    firebaseUid: text("firebase_uid"),

    role: groupParticipantRoleEnum("role").notNull().default("member"),
    status: groupParticipantStatusEnum("status").notNull().default("active"),

    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    leaveReason: groupParticipantLeaveReasonEnum("leave_reason"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identifierPresent: check(
      "group_participants_identifier_present",
      sql`${table.phone} IS NOT NULL OR ${table.senderExternalId} IS NOT NULL OR ${table.waId} IS NOT NULL`
    ),
    uniquePhoneIdx: uniqueIndex("group_participants_unique_phone_idx")
      .on(table.groupExternalId, table.protocol, table.phone)
      .where(sql`${table.phone} IS NOT NULL`),
    uniqueExternalIdIdx: uniqueIndex("group_participants_unique_external_id_idx")
      .on(table.groupExternalId, table.protocol, table.senderExternalId)
      .where(sql`${table.senderExternalId} IS NOT NULL`),
    groupStatusIdx: index("group_participants_group_status_idx").on(
      table.messagingGroupId,
      table.status
    ),
    userIdIdx: index("group_participants_user_id_idx")
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    professionalIdIdx: index("group_participants_professional_id_idx")
      .on(table.professionalId)
      .where(sql`${table.professionalId} IS NOT NULL`),
  })
);

export const groupParticipantsRelations = relations(groupParticipants, ({ one }) => ({
  messagingGroup: one(messagingGroups, {
    fields: [groupParticipants.messagingGroupId],
    references: [messagingGroups.id],
  }),
}));

export type GroupParticipant = typeof groupParticipants.$inferSelect;
export type NewGroupParticipant = typeof groupParticipants.$inferInsert;
export type GroupParticipantRole = (typeof groupParticipantRoleEnum.enumValues)[number];
export type GroupParticipantStatus = (typeof groupParticipantStatusEnum.enumValues)[number];
export type GroupParticipantLeaveReason =
  (typeof groupParticipantLeaveReasonEnum.enumValues)[number];
