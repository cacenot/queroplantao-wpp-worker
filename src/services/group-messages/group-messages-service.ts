import { randomUUID } from "node:crypto";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../../db/repositories/message-moderations-repository.ts";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { NewGroupMessage, NewGroupMessageZapi } from "../../db/schema/group-messages.ts";
import type { MessageModeration } from "../../db/schema/message-moderations.ts";
import type { NormalizedZapiMessage } from "../../gateways/whatsapp/zapi/message-normalizer.ts";
import { logger } from "../../lib/logger.ts";
import { computeContentHash, computeIngestionDedupeHash } from "../../lib/message-hash.ts";
import type { MessagingGroupsCache } from "../messaging-groups/messaging-groups-cache.ts";
import type { TaskService } from "../task/index.ts";
import type { IngestContext, IngestOutcome } from "./types.ts";

type GroupMessagesServiceOptions = {
  groupMessagesRepo: GroupMessagesRepository;
  moderationsRepo: MessageModerationsRepository;
  messagingGroupsRepo: MessagingGroupsRepository;
  messagingGroupsCache: MessagingGroupsCache;
  taskService: TaskService;
  moderationVersion: string;
  ingestionDedupeWindowMs: number;
  moderationReuseWindowMs: number;
  moderationModelId: string;
};

export class GroupMessagesService {
  constructor(private readonly options: GroupMessagesServiceOptions) {}

  async ingestZapi(normalized: NormalizedZapiMessage, ctx: IngestContext): Promise<IngestOutcome> {
    const {
      groupMessagesRepo,
      messagingGroupsCache,
      messagingGroupsRepo,
      ingestionDedupeWindowMs,
    } = this.options;

    const monitored = await messagingGroupsCache.isMonitored(
      normalized.groupExternalId,
      normalized.protocol
    );
    if (!monitored) {
      return { status: "ignored", reason: "group-not-monitored" };
    }

    const content = normalized.normalizedText ?? normalized.caption ?? "";
    const contentForHash = content || normalized.mediaUrl || "";

    const ingestionDedupeHash = computeIngestionDedupeHash(
      {
        protocol: normalized.protocol,
        groupExternalId: normalized.groupExternalId,
        senderPhone: normalized.senderPhone,
        senderExternalId: normalized.senderExternalId,
        content: contentForHash,
        sentAt: normalized.sentAt,
      },
      ingestionDedupeWindowMs
    );
    const contentHash = computeContentHash(contentForHash);

    const messagingGroup = await messagingGroupsRepo.findByExternalId(normalized.groupExternalId);

    const messageRow: NewGroupMessage = {
      ingestionDedupeHash,
      contentHash,
      protocol: normalized.protocol,
      providerKind: normalized.providerKind,
      providerInstanceId: ctx.providerInstanceId,
      groupExternalId: normalized.groupExternalId,
      messagingGroupId: messagingGroup?.id ?? null,
      senderPhone: normalized.senderPhone,
      senderExternalId: normalized.senderExternalId,
      senderName: normalized.senderName,
      externalMessageId: normalized.externalMessageId,
      referenceExternalMessageId: normalized.referenceExternalMessageId,
      messageType: normalized.messageType,
      messageSubtype: normalized.messageSubtype,
      hasText: normalized.hasText,
      normalizedText: normalized.normalizedText,
      mediaUrl: normalized.mediaUrl,
      thumbnailUrl: normalized.thumbnailUrl,
      mimeType: normalized.mimeType,
      caption: normalized.caption,
      sentAt: normalized.sentAt,
      fromMe: normalized.fromMe,
      isForwarded: normalized.isForwarded,
      isEdited: normalized.isEdited,
      moderationStatus: "pending",
    };

    const zapiRow: NewGroupMessageZapi = {
      groupMessageId: "",
      zapiInstanceExternalId: normalized.zapi.instanceExternalId,
      connectedPhone: normalized.zapi.connectedPhone,
      chatName: normalized.zapi.chatName,
      status: normalized.zapi.status,
      senderLid: normalized.zapi.senderLid,
      waitingMessage: normalized.zapi.waitingMessage,
      viewOnce: normalized.zapi.viewOnce,
      extractedPayload: normalized.zapi.extractedPayload,
      rawPayload: normalized.zapi.rawPayload,
    };

    const { row, isNew } = await groupMessagesRepo.upsertByIngestionHash(messageRow, zapiRow);

    if (!isNew) {
      return { status: "duplicate", messageId: row.id };
    }

    return this.resolveModeration(row.id, contentHash);
  }

  private async resolveModeration(messageId: string, contentHash: string): Promise<IngestOutcome> {
    const {
      groupMessagesRepo,
      moderationsRepo,
      taskService,
      moderationVersion,
      moderationReuseWindowMs,
      moderationModelId,
    } = this.options;

    const cutoff = new Date(Date.now() - moderationReuseWindowMs);
    const cached = await moderationsRepo.findReusable(contentHash, moderationVersion, cutoff);

    if (cached) {
      const reused = await this.createCachedModeration(messageId, contentHash, cached);
      await groupMessagesRepo.setCurrentModeration(messageId, reused.id, "analyzed");
      return {
        status: "reused",
        messageId,
        moderationId: reused.id,
        sourceModerationId: cached.id,
      };
    }

    const fresh = await moderationsRepo.create({
      groupMessageId: messageId,
      contentHash,
      moderationVersion,
      model: moderationModelId,
      source: "fresh",
      status: "pending",
    });

    await groupMessagesRepo.setCurrentModeration(messageId, fresh.id, "pending");

    try {
      await taskService.enqueue([
        {
          id: randomUUID(),
          type: "whatsapp.moderate_group_message",
          payload: { moderationId: fresh.id },
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      logger.error(
        { err, moderationId: fresh.id, messageId },
        "Falha ao enfileirar job de moderação — moderação fica pending"
      );
    }

    return { status: "queued", messageId, moderationId: fresh.id };
  }

  private async createCachedModeration(
    messageId: string,
    contentHash: string,
    source: MessageModeration
  ): Promise<MessageModeration> {
    return this.options.moderationsRepo.create({
      groupMessageId: messageId,
      contentHash,
      moderationVersion: source.moderationVersion,
      model: source.model,
      source: "cached",
      sourceModerationId: source.id,
      status: "analyzed",
      reason: source.reason,
      partner: source.partner,
      category: source.category,
      confidence: source.confidence,
      action: source.action,
      rawResult: source.rawResult,
      completedAt: new Date(),
    });
  }
}
