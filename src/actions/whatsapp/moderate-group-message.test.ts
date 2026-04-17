import { describe, expect, it, mock } from "bun:test";
import type { MessageAnalysis } from "../../ai/moderator.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type {
  MessageModerationsRepository,
  MessageWithModeration,
} from "../../db/repositories/message-moderations-repository.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { moderateGroupMessage } from "./moderate-group-message.ts";

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
  it("classifica e persiste os resultados", async () => {
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
    const classify = mock(() => Promise.resolve(analysis));

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, classify }
    );

    expect(classify).toHaveBeenCalledWith("tenho vaga de plantão");
    expect(moderationsRepo.markAnalyzed).toHaveBeenCalledTimes(1);
    const [id, fields] = (moderationsRepo.markAnalyzed as unknown as ReturnType<typeof mock>).mock
      .calls[0] as [string, { category: string; action: string; confidence: number }];
    expect(id).toBe(MODERATION_ID);
    expect(fields.category).toBe(analysis.category);
    expect(fields.action).toBe(analysis.action);
    expect(fields.confidence).toBe(analysis.confidence);

    expect(groupMessagesRepo.setModerationStatus).toHaveBeenCalledWith(MESSAGE_ID, "analyzed");
  });

  it("marca failed e propaga erro quando o LLM falha", async () => {
    const record = makeRecord();
    const moderationsRepo = {
      findByIdWithMessage: mock(() => Promise.resolve(record)),
      markAnalyzed: mock(() => Promise.resolve()),
      markFailed: mock(() => Promise.resolve()),
    } as unknown as MessageModerationsRepository;

    const groupMessagesRepo = {
      setModerationStatus: mock(() => Promise.resolve()),
    } as unknown as GroupMessagesRepository;

    const classify = mock(() => Promise.reject(new Error("LLM indisponível")));

    await expect(
      moderateGroupMessage(
        { moderationId: MODERATION_ID },
        { moderationsRepo, groupMessagesRepo, classify }
      )
    ).rejects.toThrow("LLM indisponível");

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

    const classify = mock(() => Promise.resolve(baseAnalysis()));

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, classify }
    );

    expect(classify).not.toHaveBeenCalled();
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

    const classify = mock(() => Promise.resolve(baseAnalysis()));

    await expect(
      moderateGroupMessage(
        { moderationId: MODERATION_ID },
        { moderationsRepo, groupMessagesRepo, classify }
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

    const classify = mock(() => Promise.resolve(baseAnalysis()));

    await moderateGroupMessage(
      { moderationId: MODERATION_ID },
      { moderationsRepo, groupMessagesRepo, classify }
    );

    expect(classify).toHaveBeenCalledWith("texto do caption");
  });
});
