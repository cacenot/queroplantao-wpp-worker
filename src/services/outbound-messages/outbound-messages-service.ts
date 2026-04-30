import { randomUUID } from "node:crypto";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { NewOutboundMessage } from "../../db/schema/outbound-messages.ts";
import type { OutboundContent, SendMessagePayload } from "../../jobs/schemas.ts";
import { toE164 } from "../../lib/phone.ts";
import type { TaskService } from "../task/index.ts";
import {
  InvalidPhoneError,
  ProviderInstanceNotActiveError,
  ProviderInstanceNotFoundError,
  type SendInput,
  type SendInputTarget,
  type SendOutcome,
} from "./types.ts";

type Deps = {
  outboundMessagesRepo: OutboundMessagesRepository;
  messagingGroupsRepo: MessagingGroupsRepository;
  providerInstanceRepo: MessagingProviderInstanceRepository;
  taskService: TaskService;
};

type ResolvedTarget = {
  payloadTarget: SendMessagePayload["target"];
  targetKind: "group" | "contact";
  targetExternalId: string;
};

export class OutboundMessagesService {
  constructor(private readonly deps: Deps) {}

  /**
   * Cria a row em `outbound_messages` (observabilidade) e enfileira um job
   * `whatsapp.send_message`. Idempotente quando `idempotencyKey` é fornecida —
   * chamadas repetidas retornam a row original sem duplicar envio.
   */
  async send(input: SendInput): Promise<SendOutcome> {
    const dedup = await this.findDeduplicated(input.idempotencyKey);
    if (dedup) return dedup;

    const target = resolveTarget(input.target);

    const lookup = await this.deps.providerInstanceRepo.findActiveById(input.providerInstanceId);
    if (lookup.kind === "not_found") {
      throw new ProviderInstanceNotFoundError(input.providerInstanceId);
    }
    if (lookup.kind === "not_active") {
      throw new ProviderInstanceNotActiveError(input.providerInstanceId);
    }
    const instance = lookup.instance;

    const messagingGroupId =
      target.targetKind === "group"
        ? ((
            await this.deps.messagingGroupsRepo.findByExternalId(
              target.targetExternalId,
              instance.base.protocol
            )
          )?.id ?? null)
        : null;

    let row: Awaited<ReturnType<OutboundMessagesRepository["create"]>>;
    try {
      row = await this.deps.outboundMessagesRepo.create({
        protocol: instance.base.protocol,
        providerKind: instance.base.providerKind,
        providerInstanceId: instance.base.id,
        targetKind: target.targetKind,
        targetExternalId: target.targetExternalId,
        messagingGroupId,
        contentKind: input.content.kind,
        content: input.content,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        batchId: input.batchId,
        scheduledFor: input.scheduledFor,
        requestedBy: input.requestedBy,
      } satisfies NewOutboundMessage);
    } catch (err) {
      // Race em idempotency_key: outro caller passou pelo findByIdempotencyKey
      // ao mesmo tempo, ambos chegaram no INSERT, este é o segundo. Refetch
      // garante que retornemos a row original sem propagar 23505 ao caller.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const dedupAfterInsert = await this.findDeduplicated(input.idempotencyKey);
        if (dedupAfterInsert) return dedupAfterInsert;
      }
      throw err;
    }

    const job = {
      id: randomUUID(),
      type: "whatsapp.send_message" as const,
      createdAt: new Date().toISOString(),
      payload: {
        providerInstanceId: instance.base.id,
        outboundMessageId: row.id,
        target: target.payloadTarget,
        content: input.content,
      },
    };

    await this.deps.taskService.enqueue([job]);
    await this.deps.outboundMessagesRepo.setTaskId(row.id, job.id);

    return { outboundMessageId: row.id, taskId: job.id, status: "queued" };
  }

  private async findDeduplicated(idempotencyKey: string | undefined): Promise<SendOutcome | null> {
    if (!idempotencyKey) return null;
    const existing = await this.deps.outboundMessagesRepo.findByIdempotencyKey(idempotencyKey);
    if (!existing) return null;
    return {
      outboundMessageId: existing.id,
      taskId: existing.taskId,
      status: "deduplicated",
    };
  }
}

// Postgres unique_violation. Aceita o erro como `unknown` porque o pg client
// não exporta o tipo concreto e o stack pode passar por wrappers do Drizzle.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

// E.164 só vale para targets de contato. Group externalId passa por sem
// normalizar (formato é do provider, ex.: `120363...@g.us` para Z-API).
function resolveTarget(target: SendInputTarget): ResolvedTarget {
  if (target.kind === "group") {
    return {
      payloadTarget: { kind: "group", externalId: target.externalId },
      targetKind: "group",
      targetExternalId: target.externalId,
    };
  }

  const e164 = toE164(target.phone);
  if (!e164) {
    throw new InvalidPhoneError(`Phone inválido para target.contact: ${target.phone}`);
  }
  return {
    payloadTarget: { kind: "contact", externalId: e164 },
    targetKind: "contact",
    targetExternalId: e164,
  };
}

export type { OutboundContent };
