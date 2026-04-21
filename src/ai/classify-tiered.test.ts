import { describe, expect, it, mock } from "bun:test";
import type { LanguageModel } from "ai";
import { type ClassifyTieredOptions, classifyTiered } from "./classify-tiered.ts";
import type { ClassifyExample, ClassifyMessageResult, MessageAnalysis } from "./moderator.ts";

const FAKE_PRIMARY = { __tag: "primary" } as unknown as LanguageModel;
const FAKE_ESCALATION = { __tag: "escalation" } as unknown as LanguageModel;

function analysis(overrides: Partial<MessageAnalysis> = {}): MessageAnalysis {
  return {
    reason: "mock",
    partner: null,
    category: "product_sales",
    confidence: 0.6,
    action: "remove",
    ...overrides,
  };
}

function classifyResult(a: MessageAnalysis): ClassifyMessageResult {
  return { analysis: a, usage: { promptTokens: 0, completionTokens: 0 } };
}

function baseOpts(overrides: Partial<ClassifyTieredOptions> = {}): ClassifyTieredOptions {
  return {
    primaryModel: FAKE_PRIMARY,
    primaryModelString: "openai/gpt-4o-mini",
    escalationModel: FAKE_ESCALATION,
    escalationModelString: "openai/gpt-4o",
    escalationThreshold: 0.7,
    escalationCategories: ["product_sales", "service_sales", "competitor_promotion"],
    systemPrompt: "system",
    examples: [] as ClassifyExample[],
    ...overrides,
  };
}

describe("classifyTiered", () => {
  it("não escala quando confidence >= threshold", async () => {
    const primary = analysis({ confidence: 0.9, category: "product_sales" });
    const classify = mock(() => Promise.resolve(classifyResult(primary)));

    const result = await classifyTiered("msg", baseOpts(), classify);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      analysis: primary,
      modelUsed: "openai/gpt-4o-mini",
      escalated: false,
      primaryAnalysis: null,
      usage: { promptTokens: 0, completionTokens: 0 },
    });
  });

  it("não escala quando categoria não está em escalationCategories", async () => {
    const primary = analysis({ confidence: 0.3, category: "clean" });
    const classify = mock(() => Promise.resolve(classifyResult(primary)));

    const result = await classifyTiered("msg", baseOpts(), classify);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(false);
    expect(result.modelUsed).toBe("openai/gpt-4o-mini");
  });

  it("não escala quando escalationModel é null", async () => {
    const primary = analysis({ confidence: 0.3, category: "product_sales" });
    const classify = mock(() => Promise.resolve(classifyResult(primary)));

    const result = await classifyTiered(
      "msg",
      baseOpts({ escalationModel: null, escalationModelString: null }),
      classify
    );

    expect(classify).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(false);
  });

  it("não escala quando threshold é null (escalação desligada)", async () => {
    const primary = analysis({ confidence: 0.1, category: "product_sales" });
    const classify = mock(() => Promise.resolve(classifyResult(primary)));

    const result = await classifyTiered("msg", baseOpts({ escalationThreshold: null }), classify);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(result.escalated).toBe(false);
  });

  it("escala quando confidence < threshold e categoria elegível", async () => {
    const primary = analysis({ confidence: 0.5, category: "product_sales", action: "remove" });
    const escalated = analysis({ confidence: 0.95, category: "job_opportunity", action: "allow" });

    const classify = mock((_text: string, model: LanguageModel) =>
      Promise.resolve(classifyResult(model === FAKE_PRIMARY ? primary : escalated))
    );

    const result = await classifyTiered("msg borderline", baseOpts(), classify);

    expect(classify).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      analysis: escalated,
      modelUsed: "openai/gpt-4o",
      escalated: true,
      primaryAnalysis: primary,
      usage: { promptTokens: 0, completionTokens: 0 },
    });
  });

  it("propaga systemPrompt e examples para ambas as chamadas", async () => {
    const primary = analysis({ confidence: 0.2, category: "service_sales" });
    const escalated = analysis({ confidence: 0.9 });
    const classify = mock(
      (_text: string, model: LanguageModel, _systemPrompt: string, _examples: ClassifyExample[]) =>
        Promise.resolve(classifyResult(model === FAKE_PRIMARY ? primary : escalated))
    );

    const examples: ClassifyExample[] = [{ text: "foo", analysis: primary }];
    await classifyTiered("msg", baseOpts({ systemPrompt: "custom", examples }), classify);

    expect(classify.mock.calls).toHaveLength(2);
    for (const call of classify.mock.calls) {
      expect(call[2]).toBe("custom");
      expect(call[3]).toBe(examples);
    }
  });
});
