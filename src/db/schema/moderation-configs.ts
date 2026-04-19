import { sql } from "drizzle-orm";
import {
  boolean,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MessageAnalysis } from "../../ai/moderator.ts";

export type ModerationConfigExample = {
  text: string;
  analysis: MessageAnalysis;
  note?: string;
};

export const moderationConfigs = pgTable(
  "moderation_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: text("version").notNull().unique(),
    primaryModel: text("primary_model").notNull(),
    escalationModel: text("escalation_model"),
    escalationThreshold: numeric("escalation_threshold", { precision: 3, scale: 2 }),
    escalationCategories: text("escalation_categories")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    systemPrompt: text("system_prompt").notNull(),
    examples: jsonb("examples")
      .$type<ModerationConfigExample[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(false),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (table) => ({
    // Partial unique: exatamente uma row com is_active = true no máximo.
    activeIdx: uniqueIndex("moderation_configs_active_idx")
      .on(table.isActive)
      .where(sql`${table.isActive} = true`),
  })
);

export type ModerationConfigRow = typeof moderationConfigs.$inferSelect;
export type NewModerationConfigRow = typeof moderationConfigs.$inferInsert;
