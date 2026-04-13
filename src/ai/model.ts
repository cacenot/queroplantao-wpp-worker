import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const providers: Record<string, (modelId: string) => LanguageModel> = {
  openai: (modelId) => createOpenAI()(modelId),
  anthropic: (modelId) => createAnthropic()(modelId),
  google: (modelId) => createGoogleGenerativeAI()(modelId),
};

/**
 * Cria uma instância de modelo a partir de uma string "provider/model-name".
 *
 * Exemplos:
 *   "openai/gpt-4o-mini"
 *   "anthropic/claude-sonnet-4-20250514"
 *   "google/gemini-2.0-flash"
 *
 * As API keys são lidas automaticamente das env vars padrão de cada provider:
 *   OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY
 */
export function createModel(modelString: string): LanguageModel {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Formato de modelo inválido: "${modelString}". Use "provider/model-name" (ex: "openai/gpt-4o-mini")`
    );
  }

  const providerName = modelString.slice(0, slashIndex);
  const modelId = modelString.slice(slashIndex + 1);

  const factory = providers[providerName];
  if (!factory) {
    throw new Error(
      `Provider desconhecido: "${providerName}". Providers disponíveis: ${Object.keys(providers).join(", ")}`
    );
  }

  return factory(modelId);
}
