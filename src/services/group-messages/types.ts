export type IngestOutcome =
  | { status: "ignored"; reason: "group-not-monitored" }
  | { status: "duplicate"; messageId: string }
  | { status: "queued"; messageId: string; moderationId: string }
  | { status: "reused"; messageId: string; moderationId: string; sourceModerationId: string };

export type IngestContext = {
  providerInstanceId: string | null;
};
