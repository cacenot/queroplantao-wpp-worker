import { describe, expect, it } from "bun:test";
import { messageAnalysisSchema } from "./moderator.ts";

// ---------------------------------------------------------------------------
// Tests — validação do schema de análise
// ---------------------------------------------------------------------------

describe("messageAnalysisSchema", () => {
  it("aceita um resultado válido", () => {
    const valid = {
      action: "allow" as const,
      category: "clean" as const,
      confidence: 0.95,
      reason: "Mensagem sobre vaga de plantão.",
    };

    expect(messageAnalysisSchema.parse(valid)).toEqual(valid);
  });

  it("aceita todas as combinações de action", () => {
    for (const action of ["allow", "remove", "ban"] as const) {
      const result = messageAnalysisSchema.safeParse({
        action,
        category: "clean",
        confidence: 0.5,
        reason: "test",
      });
      expect(result.success).toBe(true);
    }
  });

  it("aceita todas as categorias válidas", () => {
    const categories = [
      "clean",
      "off_topic",
      "gambling_spam",
      "product_sales",
      "service_sales",
      "piracy",
      "profanity",
      "adult_content",
      "scam",
      "other_spam",
    ] as const;

    for (const category of categories) {
      const result = messageAnalysisSchema.safeParse({
        action: "allow",
        category,
        confidence: 0.5,
        reason: "test",
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejeita action inválida", () => {
    const result = messageAnalysisSchema.safeParse({
      action: "warn",
      category: "clean",
      confidence: 0.5,
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita categoria inválida", () => {
    const result = messageAnalysisSchema.safeParse({
      action: "allow",
      category: "unknown_category",
      confidence: 0.5,
      reason: "test",
    });
    expect(result.success).toBe(false);
  });

  it("rejeita confidence fora do range 0-1", () => {
    expect(
      messageAnalysisSchema.safeParse({
        action: "allow",
        category: "clean",
        confidence: 1.5,
        reason: "test",
      }).success
    ).toBe(false);

    expect(
      messageAnalysisSchema.safeParse({
        action: "allow",
        category: "clean",
        confidence: -0.1,
        reason: "test",
      }).success
    ).toBe(false);
  });

  it("rejeita objeto sem reason", () => {
    const result = messageAnalysisSchema.safeParse({
      action: "allow",
      category: "clean",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });
});
