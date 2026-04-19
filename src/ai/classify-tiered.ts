import type { LanguageModel } from "ai";
import { logger } from "../lib/logger.ts";
import type { Category } from "./categories.ts";
import { type ClassifyExample, classifyMessage, type MessageAnalysis } from "./moderator.ts";

export type ClassifyResult = {
  analysis: MessageAnalysis;
  modelUsed: string;
  escalated: boolean;
  /** Análise do modelo primário quando houve escalação; null caso contrário. */
  primaryAnalysis: MessageAnalysis | null;
};

export type ClassifyTieredOptions = {
  primaryModel: LanguageModel;
  primaryModelString: string;
  escalationModel: LanguageModel | null;
  escalationModelString: string | null;
  escalationThreshold: number | null;
  escalationCategories: readonly Category[];
  systemPrompt: string;
  examples: ClassifyExample[];
};

type ClassifyFn = (
  text: string,
  model: LanguageModel,
  systemPrompt: string,
  examples: ClassifyExample[]
) => Promise<MessageAnalysis>;

type EscalationTarget = { model: LanguageModel; modelString: string };

/**
 * Classifica uma mensagem em 1-hop com escalação opcional por confidence.
 *
 * Escala para o modelo secundário quando TODOS verdadeiros: confidence < threshold,
 * categoria ∈ escalationCategories, escalationModel/threshold não-nulos.
 * O result escalado substitui o primary em `analysis`; o primary fica preservado
 * em `primaryAnalysis` para auditoria. Nunca cascata — 1-shot apenas.
 *
 * A fn `classify` é injetável para testes; default é `classifyMessage`.
 */
export async function classifyTiered(
  text: string,
  opts: ClassifyTieredOptions,
  classify: ClassifyFn = classifyMessage
): Promise<ClassifyResult> {
  const primary = await classify(text, opts.primaryModel, opts.systemPrompt, opts.examples);

  const target = resolveEscalationTarget(primary, opts);
  if (!target) {
    return {
      analysis: primary,
      modelUsed: opts.primaryModelString,
      escalated: false,
      primaryAnalysis: null,
    };
  }

  const escalated = await classify(text, target.model, opts.systemPrompt, opts.examples);

  logger.info(
    {
      primaryModel: opts.primaryModelString,
      primaryCategory: primary.category,
      primaryConfidence: primary.confidence,
      escalatedTo: target.modelString,
      finalCategory: escalated.category,
      finalConfidence: escalated.confidence,
    },
    "moderation escalated"
  );

  return {
    analysis: escalated,
    modelUsed: target.modelString,
    escalated: true,
    primaryAnalysis: primary,
  };
}

function resolveEscalationTarget(
  primary: MessageAnalysis,
  opts: ClassifyTieredOptions
): EscalationTarget | null {
  if (!opts.escalationModel || !opts.escalationModelString) return null;
  if (opts.escalationThreshold === null) return null;
  if (primary.confidence >= opts.escalationThreshold) return null;
  if (!(opts.escalationCategories as readonly string[]).includes(primary.category)) return null;
  return { model: opts.escalationModel, modelString: opts.escalationModelString };
}
