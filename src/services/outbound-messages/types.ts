import type { OutboundContent } from "../../jobs/schemas.ts";

export type SendInputTarget =
  | { kind: "group"; externalId: string }
  // `phone` aceita raw (qualquer formato) — o service normaliza para E.164.
  | { kind: "contact"; phone: string };

export interface SendInput {
  providerInstanceId: string;
  target: SendInputTarget;
  content: OutboundContent;
  idempotencyKey?: string;
  batchId?: string;
  scheduledFor?: Date;
  requestedBy?: string;
}

export interface SendOutcome {
  outboundMessageId: string;
  taskId: string | null;
  status: "queued" | "deduplicated";
}

export class InvalidPhoneError extends Error {
  override readonly name = "InvalidPhoneError";
}

export class ProviderInstanceNotFoundError extends Error {
  override readonly name = "ProviderInstanceNotFoundError";
  constructor(public readonly providerInstanceId: string) {
    super(`Provider instance não encontrada: ${providerInstanceId}`);
  }
}
