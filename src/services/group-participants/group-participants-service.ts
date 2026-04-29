import { randomUUID } from "node:crypto";
import type { GroupParticipantsRepository } from "../../db/repositories/group-participants-repository.ts";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type {
  GroupParticipantEventType,
  NewGroupParticipantEvent,
} from "../../db/schema/group-participant-events.ts";
import type {
  GroupParticipant,
  GroupParticipantLeaveReason,
  GroupParticipantRole,
  GroupParticipantStatus,
  NewGroupParticipant,
} from "../../db/schema/group-participants.ts";
import { extractZapiParticipantEvent } from "../../gateways/whatsapp/zapi/participant-event-normalizer.ts";
import type { ZapiReceivedWebhookPayload } from "../../gateways/whatsapp/zapi/webhook-schema.ts";
import { logger } from "../../lib/logger.ts";
import type { MessagingProviderInstanceService } from "../messaging-provider-instance/index.ts";
import type { TaskService } from "../task/index.ts";
import type {
  ApplyParticipantEventInput,
  ApplyParticipantEventOutcome,
  ApplySnapshotInput,
  ApplySnapshotOutcome,
  IngestZapiWebhookResult,
  ParticipantIdentifier,
  RecordSeenFromMessageInput,
  RecordSeenFromMessageOutcome,
  SnapshotParticipant,
} from "./types.ts";

type GroupParticipantsServiceOptions = {
  repo: GroupParticipantsRepository;
  messagingGroupsRepo: MessagingGroupsRepository;
  // Necessários apenas para `ingestZapiWebhook` (entrada via API).
  // Worker moderation chama só `applyEvent`/`recordSeenFromMessage` e pode omitir.
  instanceService?: MessagingProviderInstanceService;
  taskService?: TaskService;
};

type EventEffect = {
  status: GroupParticipantStatus | null;
  leaveReason: GroupParticipantLeaveReason | null;
  setJoinedAt: boolean;
  role: GroupParticipantRole | null;
  // true = demote só se atualmente admin (preserva owner)
  roleAppliesOnlyIfAdmin: boolean;
};

export class GroupParticipantsService {
  constructor(private readonly options: GroupParticipantsServiceOptions) {}

  /**
   * Entrada do pipeline da API: recebe o payload cru do webhook, normaliza,
   * resolve providerInstanceId e enfileira o job `whatsapp.ingest_participant_event`.
   * Retorna resultado tipado para o controller apenas mapear em HTTP.
   */
  async ingestZapiWebhook(payload: ZapiReceivedWebhookPayload): Promise<IngestZapiWebhookResult> {
    const { taskService } = this.options;
    if (!taskService) {
      throw new Error("ingestZapiWebhook requer taskService no constructor (configuração da API)");
    }

    const extracted = extractZapiParticipantEvent(payload);
    if (extracted.status === "ignored") {
      return {
        status: "ignored",
        reason: extracted.reason,
        notification: extracted.notification,
      };
    }

    const providerInstanceId = await this.resolveProviderInstanceId(payload.instanceId);

    try {
      await taskService.enqueue([
        {
          id: randomUUID(),
          type: "whatsapp.ingest_participant_event",
          createdAt: new Date().toISOString(),
          payload: {
            providerInstanceId,
            event: {
              ...extracted.data,
              occurredAt: extracted.data.occurredAt.toISOString(),
            },
          },
        },
      ]);
    } catch (err) {
      logger.warn(
        { err, notification: extracted.data.sourceNotification },
        "Falha ao enfileirar ingest_participant_event"
      );
    }

    return { status: "accepted", eventType: extracted.data.eventType };
  }

  /**
   * Aplica evento de participante: faz upsert do snapshot em `group_participants`
   * e insere um row em `group_participant_events` (idempotente por webhook).
   */
  async applyEvent(input: ApplyParticipantEventInput): Promise<ApplyParticipantEventOutcome> {
    const { repo, messagingGroupsRepo } = this.options;
    const { event } = input;

    const occurredAt =
      event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
    const effect = this.effectFor(event.eventType);
    const leftAt = effect.status === "left" ? occurredAt : null;

    const messagingGroup = await messagingGroupsRepo.findByExternalId(event.groupExternalId);
    const messagingGroupId = messagingGroup?.id ?? null;

    let upserted = 0;
    let eventsInserted = 0;
    let eventsSkipped = 0;

    for (const target of event.targets) {
      if (!target.phone && !target.senderExternalId) continue;

      const participant = await this.upsertOne({
        target,
        providerKind: event.providerKind,
        protocol: event.protocol,
        groupExternalId: event.groupExternalId,
        displayName: this.resolveDisplayNameForTarget(event.actor, event.displayName, target),
        effect,
        leftAt,
        occurredAt,
        messagingGroupId,
      });
      upserted++;

      const inserted = await repo.insertEvent(this.buildEventRow(event, target, participant));
      if (inserted) eventsInserted++;
      else eventsSkipped++;
    }

    return { upserted, eventsInserted, eventsSkipped };
  }

  /**
   * Aplica o snapshot completo de participantes de um grupo (vindo de
   * `/light-group-metadata`). Diferente de `applyEvent`:
   *
   * - Define role explicitamente (member/admin/owner) — não delta
   * - Não escreve em `group_participant_events` (snapshot não é evento auditável)
   * - Quando `markMissingAsLeft=true`, marca participantes ativos no DB que
   *   não aparecem no snapshot como `status='left'`, `leaveReason='unknown'`
   *
   * `joined_at` só é definido se ainda não tiver valor (não regredimos para
   * `observedAt` quando o evento original já foi capturado via webhook).
   */
  async applySnapshot(input: ApplySnapshotInput): Promise<ApplySnapshotOutcome> {
    const { repo, messagingGroupsRepo } = this.options;
    const messagingGroup = await messagingGroupsRepo.findByExternalId(input.groupExternalId);
    const messagingGroupId = messagingGroup?.id ?? null;

    const seenIds = new Set<string>();
    let upserted = 0;

    for (const participant of input.participants) {
      if (!participant.phone && !participant.senderExternalId && !participant.waId) continue;

      const row = await this.upsertSnapshotParticipant({
        participant,
        protocol: input.protocol,
        providerKind: input.providerKind,
        groupExternalId: input.groupExternalId,
        observedAt: input.observedAt,
        messagingGroupId,
      });
      seenIds.add(row.id);
      upserted++;
    }

    let markedAsLeft = 0;
    if (input.markMissingAsLeft) {
      const active = await repo.findActiveByGroup(input.groupExternalId, input.protocol);
      for (const existing of active) {
        if (seenIds.has(existing.id)) continue;
        await repo.update(existing.id, {
          status: "left",
          leftAt: input.observedAt,
          leaveReason: "unknown",
          lastEventAt: input.observedAt,
        });
        markedAsLeft++;
      }
    }

    return {
      upserted,
      markedAsLeft,
      totalParticipants: input.participants.length,
    };
  }

  private async upsertSnapshotParticipant(args: {
    participant: SnapshotParticipant;
    protocol: ApplySnapshotInput["protocol"];
    providerKind: ApplySnapshotInput["providerKind"];
    groupExternalId: string;
    observedAt: Date;
    messagingGroupId: string | null;
  }) {
    const { participant, protocol, providerKind, groupExternalId, observedAt, messagingGroupId } =
      args;
    const { repo } = this.options;

    const identifier: ParticipantIdentifier = {
      phone: participant.phone,
      senderExternalId: participant.senderExternalId,
    };
    const existing = await repo.findByIdentifier(groupExternalId, protocol, identifier);

    if (existing) {
      const patch: Partial<NewGroupParticipant> = {
        status: "active",
        leftAt: null,
        leaveReason: null,
        role:
          existing.role === "owner" && participant.role !== "owner" ? "owner" : participant.role,
        lastEventAt: observedAt,
      };
      if (!existing.waId && participant.waId) patch.waId = participant.waId;
      if (!existing.phone && participant.phone) {
        const conflict = await repo.hasOtherRowWithIdentifier(
          groupExternalId,
          protocol,
          existing.id,
          { phone: participant.phone }
        );
        if (!conflict) patch.phone = participant.phone;
      }
      if (!existing.senderExternalId && participant.senderExternalId) {
        const conflict = await repo.hasOtherRowWithIdentifier(
          groupExternalId,
          protocol,
          existing.id,
          { senderExternalId: participant.senderExternalId }
        );
        if (!conflict) patch.senderExternalId = participant.senderExternalId;
      }
      if (messagingGroupId && !existing.messagingGroupId) {
        patch.messagingGroupId = messagingGroupId;
      }
      return repo.update(existing.id, patch);
    }

    const newRow: NewGroupParticipant = {
      messagingGroupId,
      groupExternalId,
      protocol,
      providerKind,
      phone: participant.phone,
      senderExternalId: participant.senderExternalId,
      waId: participant.waId,
      displayName: null,
      role: participant.role,
      status: "active",
      joinedAt: null,
      leftAt: null,
      leaveReason: null,
      firstSeenAt: observedAt,
      lastEventAt: observedAt,
    };
    const inserted = await repo.insert(newRow);
    if (inserted) return inserted;

    // Race com outro processo (sync paralelo, webhook concorrente).
    const raced = await repo.findByIdentifier(groupExternalId, protocol, identifier);
    if (!raced) {
      throw new Error(
        `Snapshot INSERT com conflito mas findByIdentifier não achou row para group=${groupExternalId}`
      );
    }
    return raced;
  }

  /**
   * Grava que o sender foi "visto" no grupo por causa de uma mensagem ingerida.
   * Apenas upsert do snapshot — NÃO insere row em `group_participant_events`.
   *
   * Motivo: com ~1200 grupos em produção, gerar event row por mensagem dobraria
   * a carga de write no DB sem consumidor de leitura para esse histórico.
   * `last_event_at` no snapshot já é suficiente pra observabilidade de atividade.
   */
  async recordSeenFromMessage(
    input: RecordSeenFromMessageInput
  ): Promise<RecordSeenFromMessageOutcome> {
    const { messagingGroupsRepo } = this.options;
    const { sender } = input;

    if (!sender.phone && !sender.senderExternalId) {
      return { status: "skipped" };
    }

    const seenAt = input.seenAt instanceof Date ? input.seenAt : new Date(input.seenAt);
    const messagingGroup = await messagingGroupsRepo.findByExternalId(input.groupExternalId);

    await this.upsertOne({
      target: sender,
      providerKind: input.providerKind,
      protocol: input.protocol,
      groupExternalId: input.groupExternalId,
      displayName: input.displayName,
      effect: {
        status: null,
        leaveReason: null,
        setJoinedAt: false,
        role: null,
        roleAppliesOnlyIfAdmin: false,
      },
      leftAt: null,
      occurredAt: seenAt,
      messagingGroupId: messagingGroup?.id ?? null,
    });

    return { status: "upserted" };
  }

  private async resolveProviderInstanceId(instanceId: string | undefined): Promise<string | null> {
    const { instanceService } = this.options;
    if (!instanceId || !instanceService) return null;
    try {
      return await instanceService.resolveProviderInstanceIdByZapiInstanceId(instanceId);
    } catch (err) {
      logger.warn(
        { err, instanceId },
        "Falha ao resolver providerInstanceId para participant event — seguindo com null"
      );
      return null;
    }
  }

  private resolveDisplayNameForTarget(
    actor: ParticipantIdentifier | null,
    displayName: string | null,
    target: ParticipantIdentifier
  ): string | null {
    // displayName do evento refere-se ao executor (participantPhone/senderName
    // da Z-API) — só aplicamos ao alvo se ele coincide com o actor. Quando não há
    // actor (ex.: joined_inferred via msg), displayName vem do próprio remetente = target.
    if (!actor) return displayName;
    return this.identityMatches(actor, target) ? displayName : null;
  }

  private async upsertOne(args: {
    target: ParticipantIdentifier;
    providerKind: ApplyParticipantEventInput["event"]["providerKind"];
    protocol: ApplyParticipantEventInput["event"]["protocol"];
    groupExternalId: string;
    displayName: string | null;
    effect: EventEffect;
    leftAt: Date | null;
    occurredAt: Date;
    messagingGroupId: string | null;
  }): Promise<GroupParticipant> {
    const {
      target,
      providerKind,
      protocol,
      groupExternalId,
      displayName,
      effect,
      leftAt,
      occurredAt,
      messagingGroupId,
    } = args;
    const { repo } = this.options;

    const existing = await repo.findByIdentifier(groupExternalId, protocol, target);

    if (existing) {
      return repo.update(
        existing.id,
        await this.buildUpdatePatch({
          existing,
          target,
          effect,
          leftAt,
          occurredAt,
          displayName,
          protocol,
          groupExternalId,
        })
      );
    }

    // Tenta inserir; se conflitar (race com outro worker inserindo mesmo alvo),
    // re-busca e faz update.
    const newRow: NewGroupParticipant = {
      messagingGroupId,
      groupExternalId,
      protocol,
      providerKind,
      phone: target.phone,
      senderExternalId: target.senderExternalId,
      waId: null,
      displayName,
      role: effect.role ?? "member",
      status: effect.status ?? "active",
      joinedAt: effect.setJoinedAt ? occurredAt : null,
      leftAt,
      leaveReason: effect.leaveReason,
      firstSeenAt: occurredAt,
      lastEventAt: occurredAt,
    };

    const inserted = await repo.insert(newRow);
    if (inserted) return inserted;

    // Race: outro processo inseriu com o mesmo phone ou LID entre o find e o insert.
    const racedExisting = await repo.findByIdentifier(groupExternalId, protocol, target);
    if (!racedExisting) {
      throw new Error(
        `INSERT com conflito mas findByIdentifier não achou linha para group=${groupExternalId}`
      );
    }
    return repo.update(
      racedExisting.id,
      await this.buildUpdatePatch({
        existing: racedExisting,
        target,
        effect,
        leftAt,
        occurredAt,
        displayName,
        protocol,
        groupExternalId,
      })
    );
  }

  private async buildUpdatePatch(args: {
    existing: GroupParticipant;
    target: ParticipantIdentifier;
    effect: EventEffect;
    leftAt: Date | null;
    occurredAt: Date;
    displayName: string | null;
    protocol: ApplyParticipantEventInput["event"]["protocol"];
    groupExternalId: string;
  }): Promise<Partial<NewGroupParticipant>> {
    const { existing, target, effect, leftAt, occurredAt, displayName, protocol, groupExternalId } =
      args;
    const { repo } = this.options;
    const patch: Partial<NewGroupParticipant> = { lastEventAt: occurredAt };

    // Consolida identificadores: o mesmo participante pode ter chegado por phone
    // em um evento e por LID em outro — preenche o que falta. Mas antes verifica
    // se já existe OUTRO row no grupo com esse phone/LID (split de identidade)
    // pra não violar o unique parcial.
    if (!existing.phone && target.phone) {
      const conflict = await repo.hasOtherRowWithIdentifier(
        groupExternalId,
        protocol,
        existing.id,
        {
          phone: target.phone,
        }
      );
      if (conflict) {
        logger.warn(
          {
            groupExternalId,
            existingId: existing.id,
            phone: target.phone,
            lid: existing.senderExternalId,
          },
          "Split de identidade: phone já está em outro row — mantém rows separados"
        );
      } else {
        patch.phone = target.phone;
      }
    }
    if (!existing.senderExternalId && target.senderExternalId) {
      const conflict = await repo.hasOtherRowWithIdentifier(
        groupExternalId,
        protocol,
        existing.id,
        {
          senderExternalId: target.senderExternalId,
        }
      );
      if (conflict) {
        logger.warn(
          {
            groupExternalId,
            existingId: existing.id,
            phone: existing.phone,
            lid: target.senderExternalId,
          },
          "Split de identidade: LID já está em outro row — mantém rows separados"
        );
      } else {
        patch.senderExternalId = target.senderExternalId;
      }
    }

    if (displayName && displayName !== existing.displayName) {
      patch.displayName = displayName;
    }

    if (effect.status) {
      patch.status = effect.status;
      patch.leftAt = leftAt;
      patch.leaveReason = effect.leaveReason;
    }

    if (effect.setJoinedAt && !existing.joinedAt) {
      patch.joinedAt = occurredAt;
    }

    if (effect.role) {
      if (effect.roleAppliesOnlyIfAdmin) {
        if (existing.role === "admin") patch.role = effect.role;
      } else if (existing.role !== "owner") {
        patch.role = effect.role;
      }
    }

    return patch;
  }

  private buildEventRow(
    event: ApplyParticipantEventInput["event"],
    target: ParticipantIdentifier,
    participant: GroupParticipant
  ): NewGroupParticipantEvent {
    const occurredAt =
      event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
    return {
      groupParticipantId: participant.id,
      groupExternalId: event.groupExternalId,
      protocol: event.protocol,
      providerKind: event.providerKind,
      eventType: event.eventType,
      targetPhone: target.phone,
      targetSenderExternalId: target.senderExternalId,
      targetWaId: null,
      actorPhone: event.actor?.phone ?? null,
      actorSenderExternalId: event.actor?.senderExternalId ?? null,
      sourceWebhookMessageId: event.sourceWebhookMessageId,
      sourceNotification: event.sourceNotification,
      rawPayload: event.rawPayload,
      occurredAt,
    };
  }

  private effectFor(eventType: GroupParticipantEventType): EventEffect {
    switch (eventType) {
      case "joined_add":
      case "joined_invite_link":
      case "joined_non_admin_add":
      case "joined_inferred":
        return {
          status: "active",
          leaveReason: null,
          setJoinedAt: true,
          role: null,
          roleAppliesOnlyIfAdmin: false,
        };
      case "left_removed":
        return {
          status: "left",
          leaveReason: "removed_by_admin",
          setJoinedAt: false,
          role: null,
          roleAppliesOnlyIfAdmin: false,
        };
      case "left_voluntary":
        return {
          status: "left",
          leaveReason: "left_voluntarily",
          setJoinedAt: false,
          role: null,
          roleAppliesOnlyIfAdmin: false,
        };
      case "promoted_admin":
        return {
          status: null,
          leaveReason: null,
          setJoinedAt: false,
          role: "admin",
          roleAppliesOnlyIfAdmin: false,
        };
      case "demoted_member":
        return {
          status: null,
          leaveReason: null,
          setJoinedAt: false,
          role: "member",
          roleAppliesOnlyIfAdmin: true,
        };
    }
  }

  private identityMatches(a: ParticipantIdentifier, b: ParticipantIdentifier): boolean {
    if (a.senderExternalId && b.senderExternalId) {
      return a.senderExternalId === b.senderExternalId;
    }
    if (a.phone && b.phone) return a.phone === b.phone;
    return false;
  }
}
