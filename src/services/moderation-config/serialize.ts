import type { Category } from "../../ai/categories.ts";
import type { ModerationConfigRow } from "../../db/schema/moderation-configs.ts";
import type { ModerationConfig } from "./types.ts";

export function toModerationConfig(row: ModerationConfigRow): ModerationConfig {
  return {
    id: row.id,
    version: row.version,
    primaryModel: row.primaryModel,
    escalationModel: row.escalationModel,
    escalationThreshold: row.escalationThreshold === null ? null : Number(row.escalationThreshold),
    escalationCategories: row.escalationCategories as Category[],
    systemPrompt: row.systemPrompt,
    examples: row.examples,
    contentHash: row.contentHash,
    isActive: row.isActive,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
