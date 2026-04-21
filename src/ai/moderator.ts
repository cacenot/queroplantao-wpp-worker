import type { LanguageModel } from "ai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { CATEGORIES } from "./categories.ts";

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

/**
 * Renderiza examples como bloco formatado anexado ao system prompt.
 * Preferido sobre `messages` few-shot porque `Output.object` usa tool-call
 * interno — turnos assistant com JSON cru confundem o schema enforcement.
 */
function renderExamples(examples: ClassifyExample[]): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((ex, i) => {
    const out = JSON.stringify(ex.analysis);
    return `Exemplo ${i + 1}:\nInput: ${JSON.stringify(ex.text)}\nOutput: ${out}`;
  });
  return `\n\n═══ EXEMPLOS ═══\n${blocks.join("\n\n")}`;
}

export async function classifyMessage(
  text: string,
  model: LanguageModel,
  systemPrompt: string,
  examples: ClassifyExample[] = []
): Promise<MessageAnalysis> {
  const system = systemPrompt + renderExamples(examples);

  const { output } = await generateText({
    model,
    system,
    prompt: text,
    output: Output.object({ schema: messageAnalysisSchema }),
  });

  if (!output) {
    throw new Error("LLM não retornou um objeto estruturado válido");
  }

  return output;
}
