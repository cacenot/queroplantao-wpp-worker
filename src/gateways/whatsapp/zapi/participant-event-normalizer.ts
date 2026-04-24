import { toE164 } from "../../../lib/phone.ts";
import type { ZapiReceivedWebhookPayload } from "./webhook-schema.ts";

export type ParticipantEventType =
  | "joined_add"
  | "joined_invite_link"
  | "joined_non_admin_add"
  | "left_removed"
  | "left_voluntary"
  | "promoted_admin"
  | "demoted_member";

export type ParticipantIdentifier = {
  phone: string | null;
  senderExternalId: string | null;
};

export type NormalizedParticipantEvent = {
  providerKind: "whatsapp_zapi";
  protocol: "whatsapp";
  groupExternalId: string;
  eventType: ParticipantEventType;
  targets: ParticipantIdentifier[];
  actor: ParticipantIdentifier | null;
  displayName: string | null;
  occurredAt: Date;
  sourceWebhookMessageId: string;
  sourceNotification: string;
  rawPayload: ZapiReceivedWebhookPayload;
};

export type ParticipantEventIgnoreReason =
  | "not-group"
  | "newsletter"
  | "broadcast"
  | "no-notification"
  | "unknown-notification"
  | "missing-group-id"
  | "missing-message-id"
  | "missing-targets";

export type ParticipantEventNormalizerResult =
  | { status: "ignored"; reason: ParticipantEventIgnoreReason; notification?: string }
  | { status: "accepted"; data: NormalizedParticipantEvent };

const NOTIFICATION_TO_EVENT: Record<string, ParticipantEventType> = {
  GROUP_PARTICIPANT_ADD: "joined_add",
  GROUP_PARTICIPANT_REMOVE: "left_removed",
  GROUP_PARTICIPANT_LEAVE: "left_voluntary",
  GROUP_PARTICIPANT_PROMOTE: "promoted_admin",
  GROUP_PARTICIPANT_DEMOTE: "demoted_member",
  // Aliases que a Z-API pode usar para promote/demote — nomes não confirmados
  // oficialmente; aceitar ambos evita gap até validarmos em produção.
  GROUP_ADMIN_PROMOTE: "promoted_admin",
  GROUP_ADMIN_DEMOTE: "demoted_member",
};

function trimmed(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

function toDateMillis(momment: number | undefined): Date {
  if (typeof momment !== "number" || !Number.isFinite(momment)) return new Date();
  const ms = momment < 1e12 ? momment * 1000 : momment;
  return new Date(ms);
}

function resolveTargets(payload: ZapiReceivedWebhookPayload): ParticipantIdentifier[] {
  const params = payload.notificationParameters;
  if (Array.isArray(params) && params.length > 0) {
    return params
      .map((raw) => ({ phone: toE164(raw), senderExternalId: null }))
      .filter((t) => t.phone !== null || t.senderExternalId !== null);
  }
  // Fallback: nenhum notificationParameters — usa participantPhone/Lid (pode
  // coincidir com o executor em GROUP_PARTICIPANT_LEAVE).
  const phone = toE164(payload.participantPhone);
  const lid = trimmed(payload.participantLid);
  if (phone || lid) return [{ phone, senderExternalId: lid }];
  return [];
}

function resolveActor(payload: ZapiReceivedWebhookPayload): ParticipantIdentifier | null {
  const phone = toE164(payload.participantPhone);
  const lid = trimmed(payload.participantLid);
  if (!phone && !lid) return null;
  return { phone, senderExternalId: lid };
}

function mapEventType(
  notification: string,
  requestMethod: string | null
): ParticipantEventType | null {
  if (notification === "MEMBERSHIP_APPROVAL_REQUEST") {
    if (requestMethod === "invite_link") return "joined_invite_link";
    if (requestMethod === "non_admin_add") return "joined_non_admin_add";
    return null;
  }
  return NOTIFICATION_TO_EVENT[notification] ?? null;
}

export function extractZapiParticipantEvent(
  payload: ZapiReceivedWebhookPayload
): ParticipantEventNormalizerResult {
  if (payload.isNewsletter === true) return { status: "ignored", reason: "newsletter" };
  if (payload.broadcast === true) return { status: "ignored", reason: "broadcast" };
  if (payload.isGroup !== true) return { status: "ignored", reason: "not-group" };

  const notification = trimmed(payload.notification);
  if (!notification) return { status: "ignored", reason: "no-notification" };

  const requestMethod = trimmed(payload.requestMethod);
  const eventType = mapEventType(notification, requestMethod);
  if (!eventType) {
    return { status: "ignored", reason: "unknown-notification", notification };
  }

  const groupExternalId = trimmed(payload.phone);
  if (!groupExternalId) return { status: "ignored", reason: "missing-group-id" };

  const sourceWebhookMessageId = trimmed(payload.messageId);
  if (!sourceWebhookMessageId) return { status: "ignored", reason: "missing-message-id" };

  const targets = resolveTargets(payload);
  if (targets.length === 0) return { status: "ignored", reason: "missing-targets" };

  const actor = resolveActor(payload);

  return {
    status: "accepted",
    data: {
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId,
      eventType,
      targets,
      actor,
      displayName: trimmed(payload.senderName),
      occurredAt: toDateMillis(payload.momment),
      sourceWebhookMessageId,
      sourceNotification: notification,
      rawPayload: payload,
    },
  };
}
