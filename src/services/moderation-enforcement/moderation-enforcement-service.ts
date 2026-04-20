import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { JobSchema } from "../../jobs/schemas.ts";
import type { PhonePoliciesService, Protocol } from "../phone-policies/index.ts";
import type { TaskService } from "../task/index.ts";

export type ModerationEnforcementInput = {
  protocol: Protocol;
  groupExternalId: string;
  senderPhone: string | null;
  senderExternalId: string | null;
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
  private readonly removeDedupTtl: number;

  constructor(options: ModerationEnforcementServiceOptions) {
    this.phonePoliciesService = options.phonePoliciesService;
    this.taskService = options.taskService;
    this.redis = options.redis;
    this.logger = options.logger;
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

    const hit = await this.phonePoliciesService.isBlacklisted(matchInput);
    if (!hit) return;

    // Dispatch via Z-API só funciona com phone — match-só-por-LID fica como warn
    // até a gateway suportar LID nativamente.
    if (!input.senderPhone) {
      this.logger.warn(
        {
          moderationId: input.moderationId,
          groupExternalId: input.groupExternalId,
          policyId: hit.id,
          senderExternalId: input.senderExternalId,
        },
        "Enforcement: blacklist matchou por LID mas senderPhone é null — dispatch impossível via Z-API atual"
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
        policyId: hit.id,
        kicked: shouldKick,
      },
      "Enforcement: blacklist hit → enqueued delete_message + remove_participant"
    );
  }
}
