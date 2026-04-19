import type { Category } from "../../ai/categories.ts";
import type { MessageAnalysis } from "../../ai/moderator.ts";

export type ModerationConfigExample = {
  text: string;
  analysis: MessageAnalysis;
  /** Comentário do admin; não é enviado ao modelo. */
  note?: string;
};

/** Config ativa (já parseada) usada pelo worker para moderar mensagens. */
export type ModerationConfig = {
  id: string;
  version: string;
  primaryModel: string;
  escalationModel: string | null;
  escalationThreshold: number | null;
  escalationCategories: Category[];
  systemPrompt: string;
  examples: ModerationConfigExample[];
  contentHash: string;
  isActive: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateModerationConfigInput = {
  version: string;
  primaryModel: string;
  escalationModel?: string | null;
  escalationThreshold?: number | null;
  escalationCategories?: Category[];
  systemPrompt: string;
  examples?: ModerationConfigExample[];
};

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
