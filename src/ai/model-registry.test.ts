import { describe, expect, it } from "bun:test";
import { createModelRegistry } from "./model-registry.ts";

describe("ModelRegistry", () => {
  it("memoiza a mesma instância ao pedir o mesmo modelo", () => {
    const registry = createModelRegistry();
    const a = registry.getModel("openai/gpt-4o-mini");
    const b = registry.getModel("openai/gpt-4o-mini");
    expect(a).toBe(b);
  });

  it("cria instâncias distintas para strings diferentes", () => {
    const registry = createModelRegistry();
    const mini = registry.getModel("openai/gpt-4o-mini");
    const full = registry.getModel("openai/gpt-4o");
    expect(mini).not.toBe(full);
  });

  it("propaga erro de formato inválido sem cachear", () => {
    const registry = createModelRegistry();
    expect(() => registry.getModel("sem-barra")).toThrow(/Formato de modelo/);
    // Segunda chamada continua lançando — erros não são memoizados.
    expect(() => registry.getModel("sem-barra")).toThrow(/Formato de modelo/);
  });

  it("propaga erro de provider desconhecido", () => {
    const registry = createModelRegistry();
    expect(() => registry.getModel("ollama/llama3")).toThrow(/Provider desconhecido/);
  });
});
