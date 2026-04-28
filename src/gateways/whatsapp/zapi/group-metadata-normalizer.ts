import { toE164, toWaId } from "../../../lib/phone.ts";
import type {
  ZApiGroupMetadataLight,
  ZApiGroupMetadataLightParticipant,
} from "./group-metadata-schema.ts";

export type ParticipantRole = "member" | "admin" | "owner";

export type SnapshotParticipant = {
  phone: string | null;
  senderExternalId: string | null;
  waId: string | null;
  role: ParticipantRole;
};

export type NormalizedGroupSnapshot = {
  groupExternalId: string;
  participants: SnapshotParticipant[];
};

function resolveRole(p: ZApiGroupMetadataLightParticipant): ParticipantRole {
  if (p.isSuperAdmin) return "owner";
  if (p.isAdmin) return "admin";
  return "member";
}

function normalizeParticipant(p: ZApiGroupMetadataLightParticipant): SnapshotParticipant | null {
  const raw = p.phone.trim();
  if (!raw) return null;

  // LID (`<id>@lid`) → vai como senderExternalId. Sem phone/waId derivável.
  if (raw.endsWith("@lid")) {
    return {
      phone: null,
      senderExternalId: raw,
      waId: null,
      role: resolveRole(p),
    };
  }

  // Phone canonical (já formatado).
  if (raw.endsWith("@s.whatsapp.net")) {
    return {
      phone: null,
      senderExternalId: null,
      waId: raw,
      role: resolveRole(p),
    };
  }

  // Z-API digits (`5547...`) — preenche phone E.164 + waId derivado.
  const e164 = toE164(raw);
  const waId = toWaId(raw);
  if (!e164 && !waId) return null;

  return {
    phone: e164,
    senderExternalId: null,
    waId,
    role: resolveRole(p),
  };
}

export function normalizeGroupMetadataLight(
  groupExternalId: string,
  payload: ZApiGroupMetadataLight
): NormalizedGroupSnapshot {
  const participants: SnapshotParticipant[] = [];
  for (const p of payload.participants) {
    const normalized = normalizeParticipant(p);
    if (normalized) participants.push(normalized);
  }
  return { groupExternalId, participants };
}
