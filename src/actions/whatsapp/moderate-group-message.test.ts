import { describe, expect, it, mock } from "bun:test";
import type { ClassifyResult } from "../../ai/classify-tiered.ts";
import type { MessageAnalysis } from "../../ai/moderator.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type {
  MessageModerationsRepository,
  MessageWithModeration,
} from "../../db/repositories/message-moderations-repository.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { buildRawResult, moderateGroupMessage } from "./moderate-group-message.ts";

const MODERATION_ID = "00000000-0000-0000-0000-000000000001";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000002";

function baseAnalysis(): MessageAnalysis {
  return {
    reason: "vaga real",
    partner: null,
    category: "job_opportunity",
    confidence: 0.92,
    action: "allow",
  };
}

function baseResult(overrides: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    analysis: baseAnalysis(),
    modelUsed: "openai/gpt-4o-mini",
    escalated: false,
    primaryAnalysis: null,
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<MessageWithModeration["moderation"]> = {}
): MessageWithModeration {
  return {
    moderation: {
      id: MODERATION_ID,
      groupMessageId: MESSAGE_ID,
      contentHash: "hash",
      moderationVersion: "v1",
      model: "openai/gpt-4o-mini",
      source: "fresh",
      sourceModerationId: null,
      status: "pending",
      reason: null,
      partner: null,
      category: null,
      confidence: null,
      action: null,
      rawResult: null,
      promptTokens: null,
      completionTokens: null,
      latencyMs: null,
      error: null,
      createdAt: new Date(),
      completedAt: null,
      ...overrides,
    },
    message: {
      id: MESSAGE_ID,
      ingestionDedupeHash: "dedupe",
      contentHash: "hash",
      protocol: "whatsapp",
      providerKind: "whatsapp_zapi",
      providerInstanceId: null,
      groupExternalId: "120363@g.us",
      messagingGroupId: null,
      senderPhone: "5511999999999",
      senderExternalId: null,
      senderName: "Fulano",
      externalMessageId: "msg-1",
      referenceExternalMessageId: null,
      messageType: "text",
      messageSubtype: null,
      hasText: true,
      normalizedText: "tenho vaga de plantão",
      mediaUrl: null,
      thumbnailUrl: null,
      mimeType: null,
      caption: null,
      sentAt: new Date(),
      fromMe: false,
      isForwarded: false,
      isEdited: false,
      moderationStatus: "pending",
      currentModerationId: MODERATION_ID,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

describe("moderateGroupMessage", () => {
  it("classifica e persiste os resultados (sem escalação)", async () => {
    const record = makeRecord();
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const analysis = baseAnalysis();
    const moderate = mock(() =>
      Promise.resolve(baseResult({ analysis, modelUsed: "openai/gpt-4o-mini" }))
    );

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, moderate }
    );

    expect(moderate).toHaveBeenCalledWith("tenho vaga de plantão");
    expect(moderationsRepo.markAnalyzed).toHaveBeenCalledTimes(1);
    const [id, fields] = (moderationsRepo.markAnalyzed as unknown as ReturnType<typeof mock>).mock
      .calls[0] as [
      string,
      {
        model: string;
        category: string;
        action: string;
        confidence: number;
        rawResult: Record<string, unknown>;
      },
    ];
    expect(id).toBe(MODERATION_ID);
    expect(fields.model).toBe("openai/gpt-4o-mini");
    expect(fields.category).toBe(analysis.category);
    expect(fields.action).toBe(analysis.action);
    expect(fields.confidence).toBe(analysis.confidence);
    expect(fields.rawResult.escalated).toBe(false);
    expect(fields.rawResult.analysis).toEqual(analysis);
    expect(fields.rawResult.primaryAnalysis).toBeUndefined();

    expect(groupMessagesRepo.setModerationStatus).toHaveBeenCalledWith(MESSAGE_ID, "analyzed");
  });

  it("persiste modelUsed e primaryAnalysis em rawResult quando escala", async () => {
    const record = makeRecord();
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const primary: MessageAnalysis = {
      reason: "ambíguo",
      partner: null,
      category: "product_sales",
      confidence: 0.55,
      action: "remove",
    };
    const final: MessageAnalysis = {
      reason: "cert",
      partner: null,
      category: "product_sales",
      confidence: 0.9,
      action: "remove",
    };
    const moderate = mock(() =>
      Promise.resolve({
        analysis: final,
        modelUsed: "openai/gpt-4o",
        escalated: true,
        primaryAnalysis: primary,
      } as ClassifyResult)
    );

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, moderate }
    );

    const [, fields] = (moderationsRepo.markAnalyzed as unknown as ReturnType<typeof mock>).mock
      .calls[0] as [string, { model: string; rawResult: Record<string, unknown> }];
    expect(fields.model).toBe("openai/gpt-4o");
    expect(fields.rawResult.escalated).toBe(true);
    expect(fields.rawResult.analysis).toEqual(final);
    expect(fields.rawResult.primaryAnalysis).toEqual(primary);
  });

  it("propaga erro transiente sem marcar failed (para retry AMQP re-executar)", async () => {
    const record = makeRecord();
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const moderate = mock(() => Promise.reject(new Error("LLM indisponível")));

    await expect(
      moderateGroupMessage(
        { moderationId: MODERATION_ID },
        { moderationsRepo, groupMessagesRepo, moderate }
      )
    ).rejects.toThrow("LLM indisponível");

    // Erro transiente: status fica pending para o retry AMQP re-executar
    expect(moderationsRepo.markFailed).not.toHaveBeenCalled();
    expect(groupMessagesRepo.setModerationStatus).not.toHaveBeenCalled();
  });

  it("marca failed e propaga quando o LLM lança NonRetryableError", async () => {
    const record = makeRecord();
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const moderate = mock(() => Promise.reject(new NonRetryableError("conteúdo inválido")));

    await expect(
      moderateGroupMessage(
        { moderationId: MODERATION_ID },
        { moderationsRepo, groupMessagesRepo, moderate }
      )
    ).rejects.toBeInstanceOf(NonRetryableError);

    expect(moderationsRepo.markFailed).toHaveBeenCalledTimes(1);
    expect(groupMessagesRepo.setModerationStatus).toHaveBeenCalledWith(MESSAGE_ID, "failed");
  });

  it("não executa quando moderation já está terminal (idempotente)", async () => {
    const record = makeRecord({ status: "analyzed" });
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const moderate = mock(() => Promise.resolve(baseResult()));

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, moderate }
    );

    expect(moderate).not.toHaveBeenCalled();
    expect(moderationsRepo.markAnalyzed).not.toHaveBeenCalled();
  });

  it("lança NonRetryableError quando moderation inexistente", async () => {
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(null)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const moderate = mock(() => Promise.resolve(baseResult()));

    await expect(
      moderateGroupMessage(
        { moderationId: MODERATION_ID },
        { moderationsRepo, groupMessagesRepo, moderate }
      )
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("usa caption quando normalizedText é null", async () => {
    const record = makeRecord();
    record.message.normalizedText = null;
    record.message.caption = "texto do caption";

    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const moderate = mock(() => Promise.resolve(baseResult()));

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, moderate }
    );

    expect(moderate).toHaveBeenCalledWith("texto do caption");
  });
});

describe("buildRawResult", () => {
  it("inclui analysis + escalated e omite primaryAnalysis quando é null", () => {
    const raw = buildRawResult(baseResult());
    expect(raw.analysis).toEqual(baseAnalysis());
    expect(raw.escalated).toBe(false);
    expect(raw.primaryAnalysis).toBeUndefined();
  });

  it("inclui primaryAnalysis quando escala", () => {
    const primary: MessageAnalysis = {
      reason: "ambíguo",
      partner: null,
      category: "product_sales",
      confidence: 0.5,
      action: "remove",
    };
    const raw = buildRawResult(
      baseResult({ escalated: true, modelUsed: "openai/gpt-4o", primaryAnalysis: primary })
    );
    expect(raw.escalated).toBe(true);
    expect(raw.primaryAnalysis).toEqual(primary);
  });
});
