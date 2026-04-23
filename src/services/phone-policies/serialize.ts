import type { PhonePolicyRow } from "../../db/schema/phone-policies.ts";
import type { PhonePolicyView, Protocol } from "./types.ts";

export function toPhonePolicyView(row: PhonePolicyRow): PhonePolicyView {
  return {
    id: row.id,
    protocol: row.protocol as Protocol,
    kind: row.kind,
    phone: row.phone,
    waId: row.waId,
    senderExternalId: row.senderExternalId,
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
