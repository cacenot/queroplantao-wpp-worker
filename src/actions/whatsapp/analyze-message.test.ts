import { describe, expect, it, mock } from "bun:test";
import type { MessageAnalysis } from "../../ai/moderator.ts";
import type { AnalyzeMessagePayload } from "../../jobs/types.ts";
import type { QpAdminApiClient } from "../../lib/qp-admin-api.ts";
import { analyzeMessage } from "./analyze-message.ts";

const payload: AnalyzeMessagePayload = {
  hash: "abc123def456",
  text: "Bom dia, alguém tem interesse em plantão no HU?",
};

const analysis: MessageAnalysis = {
  action: "allow",
  category: "clean",
  confidence: 0.95,
  partner: null,
  reason: "Mensagem sobre vaga de plantão médico.",
};

function makeClassifyFn(result: MessageAnalysis = analysis) {
  return mock(() => Promise.resolve(result));
}

function makeApiClient(impl: () => Promise<void> = () => Promise.resolve()) {
  return {
    submitMessageAnalysis: mock(impl),
  } as unknown as QpAdminApiClient;
}

describe("analyzeMessage", () => {
  it("classifica a mensagem e persiste o resultado na API", async () => {
    const classify = makeClassifyFn();
    const apiClient = makeApiClient();

    await analyzeMessage(payload, classify, apiClient);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(payload.text);
    expect(apiClient.submitMessageAnalysis).toHaveBeenCalledTimes(1);
    expect(apiClient.submitMessageAnalysis).toHaveBeenCalledWith(payload.hash, analysis);
  });

  it("propaga erros do classificador", async () => {
    const error = new Error("LLM indisponível");
    const classify = mock(() => Promise.reject(error));
    const apiClient = makeApiClient();

    await expect(analyzeMessage(payload, classify, apiClient)).rejects.toThrow("LLM indisponível");
    expect(apiClient.submitMessageAnalysis).not.toHaveBeenCalled();
  });

  it("propaga erros do API client", async () => {
    const classify = makeClassifyFn();
    const apiClient = makeApiClient(() => Promise.reject(new Error("API fora do ar")));

    await expect(analyzeMessage(payload, classify, apiClient)).rejects.toThrow("API fora do ar");
  });
});
