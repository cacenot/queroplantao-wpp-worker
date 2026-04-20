import type { PhonePolicyRow } from "../../db/schema/phone-policies.ts";
import type { PhonePolicyView, Protocol } from "./types.ts";

export function toPhonePolicyView(row: PhonePolicyRow): PhonePolicyView {
  return {
    id: row.id,
    protocol: row.protocol as Protocol,
    kind: row.kind,
    phone: row.phone,
    groupExternalId: row.groupExternalId,
    source: row.source,
    reason: row.reason,
    notes: row.notes,
    moderationId: row.moderationId,
    metadata: row.metadata ?? {},
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Normaliza número para dígitos apenas (E.164 sem '+'). Remove sufixos de LID
 * (@s.whatsapp.net, @c.us, @lid) e qualquer caractere não-numérico.
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D+/g, "");
}
