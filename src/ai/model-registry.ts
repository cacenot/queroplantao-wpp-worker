import type { LanguageModel } from "ai";
import { createModel } from "./model.ts";

export type ModelRegistry = {
  getModel(modelString: string): LanguageModel;
};

/**
 * Memoiza instâncias `LanguageModel` por string `provider/model-name`.
 *
 * Usado no worker para que trocas de config de moderação via HTTP reusem
 * handles já alocados. Erros de formato inválido propagam sem cachear —
 * admin precisa ver a falha na hora.
 */
export function createModelRegistry(): ModelRegistry {
  const cache = new Map<string, LanguageModel>();

  return {
    getModel(modelString) {
      const cached = cache.get(modelString);
      if (cached) return cached;

      const model = createModel(modelString);
      cache.set(modelString, model);
      return model;
    },
  };
}
