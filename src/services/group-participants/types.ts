import type { GroupParticipantEventType } from "../../db/schema/group-participant-events.ts";
import type { GroupParticipantRole } from "../../db/schema/group-participants.ts";
import type {
  ParticipantEventIgnoreReason,
  ParticipantEventType,
} from "../../gateways/whatsapp/zapi/participant-event-normalizer.ts";

export type ParticipantIdentifier = {
  phone: string | null;
  senderExternalId: string | null;
};

export type SnapshotParticipant = {
  phone: string | null;
  senderExternalId: string | null;
  waId: string | null;
  role: GroupParticipantRole;
};

export type ApplySnapshotInput = {
  providerInstanceId: string | null;
  providerKind: "whatsapp_zapi";
  protocol: "whatsapp";
  groupExternalId: string;
  participants: SnapshotParticipant[];
  observedAt: Date;
  // Quando true, marca participantes que não aparecem no snapshot como
  // status="left", leaveReason="unknown". Útil pra reconciliar saídas que não
  // tiveram webhook (ex.: snapshot inicial, reconnect prolongado).
  markMissingAsLeft: boolean;
};

export type ApplySnapshotOutcome = {
  upserted: number;
  markedAsLeft: number;
  totalParticipants: number;
};

export type ApplyParticipantEventInput = {
  providerInstanceId: string | null;
  event: {
    providerKind: "whatsapp_zapi";
    protocol: "whatsapp";
    groupExternalId: string;
    eventType: GroupParticipantEventType;
    targets: ParticipantIdentifier[];
    actor: ParticipantIdentifier | null;
    displayName: string | null;
    occurredAt: string | Date;
    sourceWebhookMessageId: string;
    sourceNotification: string;
    rawPayload?: unknown;
  };
};

export type RecordSeenFromMessageInput = {
  providerInstanceId: string | null;
  providerKind: "whatsapp_zapi";
  protocol: "whatsapp";
  groupExternalId: string;
  sender: ParticipantIdentifier;
  displayName: string | null;
  seenAt: string | Date;
};

export type ApplyParticipantEventOutcome = {
  upserted: number;
  eventsInserted: number;
  eventsSkipped: number;
};

export type RecordSeenFromMessageOutcome = {
  status: "upserted" | "skipped";
};

export type IngestZapiWebhookResult =
  | { status: "accepted"; eventType: ParticipantEventType }
  | {
      status: "ignored";
      reason: ParticipantEventIgnoreReason;
      notification?: string;
    };
