import { describe, expect, it } from "bun:test";
import { createModel } from "./model.ts";

// ---------------------------------------------------------------------------
// Tests — validação do parsing de model string
// ---------------------------------------------------------------------------

describe("createModel", () => {
  it("lança erro quando formato não contém '/'", () => {
    expect(() => createModel("gpt-4o-mini")).toThrow("Formato de modelo inválido");
  });

  it("lança erro para provider desconhecido", () => {
    expect(() => createModel("unknown/model-123")).toThrow("Provider desconhecido");
    expect(() => createModel("unknown/model-123")).toThrow("unknown");
  });

  it("cria modelo OpenAI sem erro", () => {
    const model = createModel("openai/gpt-4o-mini");
    expect(model).toBeDefined();
  });

  it("cria modelo Anthropic sem erro", () => {
    const model = createModel("anthropic/claude-sonnet-4-20250514");
    expect(model).toBeDefined();
  });

  it("cria modelo Google sem erro", () => {
    const model = createModel("google/gemini-2.0-flash");
    expect(model).toBeDefined();
  });
});
