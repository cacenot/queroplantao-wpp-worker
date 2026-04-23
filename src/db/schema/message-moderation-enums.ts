import { pgEnum } from "drizzle-orm/pg-core";

export const messageModerationStatusEnum = pgEnum("message_moderation_status", [
  "pending",
  "skipped",
  "analyzed",
  "failed",
]);

export const messageModerationSourceEnum = pgEnum("message_moderation_source", [
  "fresh",
  "cached",
  "manual",
]);
