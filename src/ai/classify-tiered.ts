import type { LanguageModel } from "ai";
import { logger } from "../lib/logger.ts";
import type { Category } from "./categories.ts";
import {
  type ClassifyExample,
  type ClassifyMessageResult,
  classifyMessage,
  type MessageAnalysis,
} from "./moderator.ts";

export type ClassifyResult = {
  analysis: MessageAnalysis;
  modelUsed: string;
  escalated: boolean;
  /** Análise do modelo primário quando houve escalação; null caso contrário. */
  primaryAnalysis: MessageAnalysis | null;
  usage: { promptTokens: number; completionTokens: number };
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
) => Promise<ClassifyMessageResult>;

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

  const target = resolveEscalationTarget(primary.analysis, opts);
  if (!target) {
    return {
      analysis: primary.analysis,
      modelUsed: opts.primaryModelString,
      escalated: false,
      primaryAnalysis: null,
      usage: primary.usage,
    };
  }

  const escalated = await classify(text, target.model, opts.systemPrompt, opts.examples);

  logger.info(
    {
      primaryModel: opts.primaryModelString,
      primaryCategory: primary.analysis.category,
      primaryConfidence: primary.analysis.confidence,
      escalatedTo: target.modelString,
      finalCategory: escalated.analysis.category,
      finalConfidence: escalated.analysis.confidence,
    },
    "moderation escalated"
  );

  return {
    analysis: escalated.analysis,
    modelUsed: target.modelString,
    escalated: true,
    primaryAnalysis: primary.analysis,
    usage: {
      promptTokens: primary.usage.promptTokens + escalated.usage.promptTokens,
      completionTokens: primary.usage.completionTokens + escalated.usage.completionTokens,
    },
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
