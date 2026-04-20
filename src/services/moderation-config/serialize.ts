import { z } from "zod";
import { CATEGORIES, type Category } from "../../ai/categories.ts";
import { messageAnalysisSchema } from "../../ai/moderator.ts";
import type {
  ModerationConfigExample,
  ModerationConfigRow,
} from "../../db/schema/moderation-configs.ts";
import { logger } from "../../lib/logger.ts";
import type { ModerationConfig } from "./types.ts";

const exampleSchema = z.object({
  text: z.string(),
  analysis: messageAnalysisSchema,
  note: z.string().optional(),
});
const examplesSchema = z.array(exampleSchema);
const escalationCategoriesSchema = z.array(z.enum(CATEGORIES));

export function toModerationConfig(row: ModerationConfigRow): ModerationConfig {
  return {
    id: row.id,
    version: row.version,
    primaryModel: row.primaryModel,
    escalationModel: row.escalationModel,
    escalationThreshold: row.escalationThreshold === null ? null : Number(row.escalationThreshold),
    escalationCategories: parseEscalationCategories(row.escalationCategories, row.version),
    systemPrompt: row.systemPrompt,
    examples: parseExamples(row.examples, row.version),
    contentHash: row.contentHash,
    isActive: row.isActive,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// `examples` e `escalationCategories` vêm de jsonb/text[] sem validação no DB.
// Schema drift ou dados legados não devem derrubar o worker — degrada para [] + warn
// para o admin ver no log/Sentry e corrigir a config.
function parseExamples(raw: unknown, version: string): ModerationConfigExample[] {
  const parsed = examplesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn(
    { version, issues: parsed.error.issues },
    "moderation_configs.examples inválido — caindo para []"
  );
  return [];
}

function parseEscalationCategories(raw: unknown, version: string): Category[] {
  const parsed = escalationCategoriesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger.warn(
    { version, issues: parsed.error.issues },
    "moderation_configs.escalation_categories inválido — caindo para []"
  );
  return [];
}
