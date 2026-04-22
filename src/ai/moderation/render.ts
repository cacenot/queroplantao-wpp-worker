import type { ClassifyExample } from "../moderator.ts";

/**
 * Renderiza examples como bloco de texto anexado ao system prompt.
 * Formato legível pra LLM (substitui o JSON cru do `moderator.ts` original).
 * Preferido sobre `messages` few-shot porque `Output.object` usa tool-call
 * interno — turnos assistant com JSON cru confundem o schema enforcement.
 */
export function renderExamples(examples: ClassifyExample[]): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((ex, i) => {
    const decision = [
      `category=${ex.analysis.category}`,
      `action=${ex.analysis.action}`,
      `partner=${ex.analysis.partner ?? "null"}`,
    ].join(", ");
    return `═══ EXEMPLO ${i + 1} ═══\nMENSAGEM:\n${ex.text}\n\nDECISÃO: ${decision}\nRAZÃO: ${ex.analysis.reason}`;
  });
  return `\n\n${blocks.join("\n\n")}`;
}
