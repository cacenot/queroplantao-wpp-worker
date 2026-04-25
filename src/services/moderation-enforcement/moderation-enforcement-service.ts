import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { JobSchema } from "../../jobs/schemas.ts";
import type { ContentFilterHit, ContentFilterService } from "../content-filter/index.ts";
import {
  type AddPhonePolicyInput,
  ConflictError,
  type PhonePoliciesService,
  type Protocol,
} from "../phone-policies/index.ts";
import type { TaskService } from "../task/index.ts";

export type ModerationEnforcementInput = {
  protocol: Protocol;
  groupExternalId: string;
  senderPhone: string | null;
  senderExternalId: string | null;
  senderName: string | null;
  normalizedText: string | null;
  caption: string | null;
  providerInstanceId: string | null;
  externalMessageId: string;
  moderationId: string;
  groupMessageId: string;
};

type ModerationEnforcementServiceOptions = {
  phonePoliciesService: PhonePoliciesService;
  taskService: TaskService;
  redis: Redis;
  logger: Logger;
  contentFilter?: ContentFilterService;
  contentFilterEnabled?: boolean;
  // Default true: preserva comportamento histórico. Desligar inibe a consulta de
  // blacklist e o ban automático correspondente (content-filter segue independente).
  blacklistEnforcementEnabled?: boolean;
  // Janela em segundos durante a qual um mesmo (grupo, phone) só é kickado uma vez.
  // O delete não dedupa porque externalMessageId é único por mensagem.
  removeParticipantDedupTtlSeconds?: number;
};

const DEFAULT_REMOVE_DEDUP_TTL_SECONDS = 300;

export class ModerationEnforcementService {
  private readonly phonePoliciesService: PhonePoliciesService;
  private readonly taskService: TaskService;
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly contentFilter: ContentFilterService | undefined;
  private readonly contentFilterEnabled: boolean;
  private readonly blacklistEnforcementEnabled: boolean;
  private readonly removeDedupTtl: number;

  constructor(options: ModerationEnforcementServiceOptions) {
    this.phonePoliciesService = options.phonePoliciesService;
    this.taskService = options.taskService;
    this.redis = options.redis;
    this.logger = options.logger;
    this.contentFilter = options.contentFilter;
    this.contentFilterEnabled = options.contentFilterEnabled ?? false;
    this.blacklistEnforcementEnabled = options.blacklistEnforcementEnabled ?? true;
    this.removeDedupTtl =
      options.removeParticipantDedupTtlSeconds ?? DEFAULT_REMOVE_DEDUP_TTL_SECONDS;
  }

  async evaluateAndEnforce(input: ModerationEnforcementInput): Promise<void> {
    if (!input.senderPhone && !input.senderExternalId) return;
    if (!input.providerInstanceId) return;

    const matchInput = {
      protocol: input.protocol,
      groupExternalId: input.groupExternalId,
      phone: input.senderPhone,
      senderExternalId: input.senderExternalId,
    };

    const bypass = await this.phonePoliciesService.isBypassed(matchInput);
    if (bypass) return;

    const blacklistHit = this.blacklistEnforcementEnabled
      ? await this.phonePoliciesService.isBlacklisted(matchInput)
      : null;

    // Content-filter: segunda porta de enforcement (determinístico, atrás de feature flag)
    let contentHit: ContentFilterHit | null = null;
    if (!blacklistHit && this.contentFilterEnabled && this.contentFilter) {
      contentHit = this.contentFilter.detect({
        senderPhone: input.senderPhone,
        senderName: input.senderName,
        normalizedText: input.normalizedText,
        caption: input.caption,
      });

      if (contentHit) {
        const { motivo, match } = contentHit;
        const addInput: AddPhonePolicyInput = {
          protocol: input.protocol,
          kind: "blacklist",
          phone: input.senderPhone,
          senderExternalId: input.senderExternalId,
          groupExternalId: null,
          source: "moderation_auto",
          reason: `content-filter:${motivo}:${match}`.slice(0, 500),
          moderationId: input.moderationId,
        };

        await this.phonePoliciesService.add(addInput).catch((err) => {
          if (err instanceof ConflictError) return;
          this.logger.warn(
            { err, moderationId: input.moderationId, motivo, match },
            "Falha ao auto-add blacklist via content-filter — segue com enforcement"
          );
        });

        this.logger.info(
          {
            moderationId: input.moderationId,
            motivo,
            match,
            phone: input.senderPhone,
            lid: input.senderExternalId,
          },
          "Content-filter: hit → auto-blacklist registrado"
        );
      }
    }

    const enforcementReason: "blacklist" | "content-filter" | null = blacklistHit
      ? "blacklist"
      : contentHit
        ? "content-filter"
        : null;
    if (!enforcementReason) return;

    // Dispatch via Z-API só funciona com phone — match-só-por-LID fica como warn
    // até a gateway suportar LID nativamente.
    if (!input.senderPhone) {
      this.logger.warn(
        {
          moderationId: input.moderationId,
          groupExternalId: input.groupExternalId,
          reason: enforcementReason,
          policyId: blacklistHit?.id ?? null,
          senderExternalId: input.senderExternalId,
        },
        `Enforcement: ${enforcementReason} matchou por LID mas senderPhone é null — dispatch impossível via Z-API atual`
      );
      return;
    }

    const phone = input.senderPhone;
    const providerInstanceId = input.providerInstanceId;

    const removeDedupKey = `enforcement:remove:${input.protocol}:${input.groupExternalId}:${phone}`;
    const acquired = await this.redis.set(removeDedupKey, "1", "EX", this.removeDedupTtl, "NX");
    const shouldKick = acquired === "OK";

    const createdAt = new Date().toISOString();
    const jobs: JobSchema[] = [
      {
        id: randomUUID(),
        type: "whatsapp.delete_message",
        payload: {
          providerInstanceId,
          messageId: input.externalMessageId,
          phone,
          owner: false,
        },
        createdAt,
      },
    ];
    if (shouldKick) {
      jobs.push({
        id: randomUUID(),
        type: "whatsapp.remove_participant",
        payload: {
          providerInstanceId,
          groupId: input.groupExternalId,
          phones: [phone],
        },
        createdAt,
      });
    }

    try {
      await this.taskService.enqueue(jobs);
    } catch (err) {
      this.logger.error(
        {
          err,
          moderationId: input.moderationId,
          groupExternalId: input.groupExternalId,
          phone,
        },
        "Enforcement: falha ao enfileirar jobs de delete/remove"
      );
      throw err;
    }

    this.logger.info(
      {
        moderationId: input.moderationId,
        groupExternalId: input.groupExternalId,
        phone,
        reason: enforcementReason,
        policyId: blacklistHit?.id ?? null,
        kicked: shouldKick,
      },
      `Enforcement: ${enforcementReason} hit → enqueued delete_message + remove_participant`
    );
  }
}
