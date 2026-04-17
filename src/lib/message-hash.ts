import { createHash } from "node:crypto";

export interface IngestionDedupeParts {
  protocol: string;
  groupExternalId: string;
  senderPhone?: string | null;
  senderExternalId?: string | null;
  content: string;
  sentAt: Date;
}

export function computeIngestionDedupeHash(parts: IngestionDedupeParts, windowMs: number): string {
  const sender = parts.senderPhone ?? parts.senderExternalId ?? "unknown";
  const bucket = Math.floor(parts.sentAt.getTime() / windowMs);
  const input = [parts.protocol, parts.groupExternalId, sender, parts.content, String(bucket)].join(
    ":"
  );
  return createHash("sha256").update(input).digest("hex");
}

export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
