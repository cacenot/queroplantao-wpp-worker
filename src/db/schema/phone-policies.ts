import { sql } from "drizzle-orm";
import {
  check,
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
    // Pelo menos um de phone, sender_external_id (LID) ou wa_id — CHECK abaixo.
    phone: text("phone"),
    senderExternalId: text("sender_external_id"),
    // Formato alternativo usado pelo WA (ex: BR 12-dig sem 9, pré-2016). Nunca use como
    // identificador canônico — phone sempre E.164. Serve só pra match em lookup.
    waId: text("wa_id"),
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
    identifierPresent: check(
      "phone_policies_identifier_present",
      sql`${table.phone} IS NOT NULL OR ${table.senderExternalId} IS NOT NULL OR ${table.waId} IS NOT NULL`
    ),
    uniquePhoneIdx: uniqueIndex("phone_policies_unique_phone_idx")
      .on(table.protocol, table.kind, table.phone, sql`COALESCE(${table.groupExternalId}, '')`)
      .where(sql`${table.phone} IS NOT NULL`),
    uniqueExternalIdIdx: uniqueIndex("phone_policies_unique_external_id_idx")
      .on(
        table.protocol,
        table.kind,
        table.senderExternalId,
        sql`COALESCE(${table.groupExternalId}, '')`
      )
      .where(sql`${table.senderExternalId} IS NOT NULL`),
    phoneLookupIdx: index("phone_policies_lookup_idx")
      .on(table.protocol, table.kind, table.phone)
      .where(sql`${table.phone} IS NOT NULL`),
    externalIdLookupIdx: index("phone_policies_external_id_lookup_idx")
      .on(table.protocol, table.kind, table.senderExternalId)
      .where(sql`${table.senderExternalId} IS NOT NULL`),
    expiresAtIdx: index("phone_policies_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
    waIdLookupIdx: index("phone_policies_wa_id_lookup_idx")
      .on(table.protocol, table.kind, table.waId)
      .where(sql`${table.waId} IS NOT NULL`),
  })
);

export type PhonePolicyRow = typeof phonePolicies.$inferSelect;
export type NewPhonePolicyRow = typeof phonePolicies.$inferInsert;
export type PhonePolicyKind = (typeof phonePolicyKindEnum.enumValues)[number];
export type PhonePolicySource = (typeof phonePolicySourceEnum.enumValues)[number];
