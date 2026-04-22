import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { CATEGORIES } from "./categories.ts";
import { renderExamples } from "./moderation/render.ts";

export const messageAnalysisSchema = z.object({
  reason: z.string(),
  partner: z.enum(["quero-plantao", "inbram", "dgs"]).nullable(),
  category: z.enum(CATEGORIES),
  confidence: z.number(),
  action: z.enum(["allow", "remove", "ban"]),
});

export type MessageAnalysis = z.infer<typeof messageAnalysisSchema>;

export type ClassifyExample = {
  text: string;
  analysis: MessageAnalysis;
  /** Comentário do admin; não é enviado ao modelo. */
  note?: string;
};

export type ClassifyMessageResult = {
  analysis: MessageAnalysis;
  usage: { promptTokens: number; completionTokens: number };
};

export async function classifyMessage(
  text: string,
  model: LanguageModel,
  systemPrompt: string,
  examples: ClassifyExample[] = []
): Promise<ClassifyMessageResult> {
  const system = systemPrompt + renderExamples(examples);

  const { output, usage } = await generateText({
    model,
    system,
    prompt: text,
    output: Output.object({ schema: messageAnalysisSchema }),
  });

  if (!output) {
    throw new Error("LLM não retornou um objeto estruturado válido");
  }

  return {
    analysis: output,
    usage: { promptTokens: usage.inputTokens ?? 0, completionTokens: usage.outputTokens ?? 0 },
  };
}
