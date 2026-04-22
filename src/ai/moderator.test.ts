import { describe, expect, it } from "bun:test";
import { CATEGORIES } from "./categories.ts";
import { messageAnalysisSchema } from "./moderator.ts";

// ---------------------------------------------------------------------------
// Tests — validação do schema de análise
// ---------------------------------------------------------------------------

describe("messageAnalysisSchema", () => {
  it("aceita um resultado válido", () => {
    const valid = {
      reason: "Mensagem sobre vaga de plantão.",
      partner: null,
      action: "allow" as const,
      category: "clean" as const,
      confidence: 0.95,
    };

    expect(messageAnalysisSchema.parse(valid)).toEqual(valid);
  });

  it("aceita todas as combinações de action", () => {
    for (const action of ["allow", "remove", "ban"] as const) {
      const result = messageAnalysisSchema.safeParse({
        reason: "test",
        partner: null,
        action,
        category: "clean",
        confidence: 0.5,
      });
      expect(result.success).toBe(true);
    }
  });

  it("aceita todas as categorias válidas", () => {
    for (const category of CATEGORIES) {
      const result = messageAnalysisSchema.safeParse({
        reason: "test",
        partner: null,
        action: "allow",
        category,
        confidence: 0.5,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejeita action inválida", () => {
    const result = messageAnalysisSchema.safeParse({
      reason: "test",
      partner: null,
      action: "warn",
      category: "clean",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejeita categoria inválida", () => {
    const result = messageAnalysisSchema.safeParse({
      reason: "test",
      partner: null,
      action: "allow",
      category: "unknown_category",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("aceita confidence fora do range 0-1 (validação via prompt, não schema)", () => {
    expect(
      messageAnalysisSchema.safeParse({
        reason: "test",
        partner: null,
        action: "allow",
        category: "clean",
        confidence: 1.5,
      }).success
    ).toBe(true);
  });

  it("rejeita objeto sem reason", () => {
    const result = messageAnalysisSchema.safeParse({
      partner: null,
      action: "allow",
      category: "clean",
      confidence: 0.5,
    });
    expect(result.success).toBe(false);
  });
});
