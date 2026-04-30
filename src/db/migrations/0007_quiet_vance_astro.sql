CREATE TYPE "public"."outbound_message_content_kind" AS ENUM('text', 'image', 'video', 'link', 'location', 'buttons');--> statement-breakpoint
CREATE TYPE "public"."outbound_message_status" AS ENUM('pending', 'queued', 'sending', 'sent', 'failed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."outbound_message_target_kind" AS ENUM('group', 'contact');--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'whatsapp.send_message';--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"provider_instance_id" uuid,
	"target_kind" "outbound_message_target_kind" NOT NULL,
	"target_external_id" text NOT NULL,
	"messaging_group_id" uuid,
	"content_kind" "outbound_message_content_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"external_message_id" text,
	"status" "outbound_message_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"task_id" uuid,
	"idempotency_key" text,
	"batch_id" uuid,
	"scheduled_for" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_messaging_group_id_messaging_groups_id_fk" FOREIGN KEY ("messaging_group_id") REFERENCES "public"."messaging_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_messages_status_created_at_idx" ON "outbound_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_provider_instance_idx" ON "outbound_messages" USING btree ("provider_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_target_idx" ON "outbound_messages" USING btree ("target_external_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_content_kind_idx" ON "outbound_messages" USING btree ("content_kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_messages_idempotency_key_idx" ON "outbound_messages" USING btree ("idempotency_key") WHERE "outbound_messages"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbound_messages_batch_status_idx" ON "outbound_messages" USING btree ("batch_id","status");