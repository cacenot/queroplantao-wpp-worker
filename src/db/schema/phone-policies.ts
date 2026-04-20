import { sql } from "drizzle-orm";
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
import { messageModerations } from "./message-moderations.ts";
import { messagingProtocolEnum } from "./provider-registry.ts";

export const phonePolicyKindEnum = pgEnum("phone_policy_kind", ["blacklist", "bypass"]);

export const phonePolicySourceEnum = pgEnum("phone_policy_source", [
  "manual",
  "moderation_auto",
  "group_admin_sync",
  "admin_api_sync",
]);

export const phonePolicies = pgTable(
  "phone_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    kind: phonePolicyKindEnum("kind").notNull(),
    phone: text("phone").notNull(),
    // NULL = política global (vale para qualquer grupo monitorado do protocolo)
    groupExternalId: text("group_external_id"),
    source: phonePolicySourceEnum("source").notNull().default("manual"),
    reason: text("reason"),
    notes: text("notes"),
    moderationId: uuid("moderation_id").references(() => messageModerations.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueIdx: uniqueIndex("phone_policies_unique_idx").on(
      table.protocol,
      table.kind,
      table.phone,
      sql`COALESCE(${table.groupExternalId}, '')`
    ),
    lookupIdx: index("phone_policies_lookup_idx").on(table.protocol, table.kind, table.phone),
    expiresAtIdx: index("phone_policies_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
  })
);

export type PhonePolicyRow = typeof phonePolicies.$inferSelect;
export type NewPhonePolicyRow = typeof phonePolicies.$inferInsert;
export type PhonePolicyKind = (typeof phonePolicyKindEnum.enumValues)[number];
export type PhonePolicySource = (typeof phonePolicySourceEnum.enumValues)[number];
