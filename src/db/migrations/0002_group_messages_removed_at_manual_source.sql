ALTER TYPE "public"."message_moderation_source" ADD VALUE 'manual';--> statement-breakpoint
ALTER TABLE "group_messages" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "group_messages_external_id_group_idx" ON "group_messages" USING btree ("external_message_id","group_external_id");