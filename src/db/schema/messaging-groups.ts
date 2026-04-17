import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { messagingProtocolEnum } from "./provider-registry.ts";

export const messagingGroups = pgTable(
  "messaging_groups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    externalId: text("external_id").notNull(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    name: text("name").notNull(),
    inviteUrl: text("invite_url"),
    imageUrl: text("image_url"),
    country: text("country"),
    uf: text("uf"),
    region: text("region"),
    city: text("city"),
    specialties: jsonb("specialties").$type<string[]>(),
    categories: jsonb("categories").$type<string[]>(),
    participantCount: integer("participant_count"),
    isCommunityVisible: boolean("is_community_visible"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalIdIdx: uniqueIndex("messaging_groups_external_id_idx").on(table.externalId),
    protocolIdx: index("messaging_groups_protocol_idx").on(table.protocol),
  })
);

export const messagingGroupsRelations = relations(messagingGroups, () => ({}));

export type MessagingGroup = typeof messagingGroups.$inferSelect;
export type NewMessagingGroup = typeof messagingGroups.$inferInsert;
