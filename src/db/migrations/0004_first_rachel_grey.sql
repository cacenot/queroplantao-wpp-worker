CREATE TYPE "public"."group_participant_event_type" AS ENUM('joined_add', 'joined_invite_link', 'joined_non_admin_add', 'joined_inferred', 'left_removed', 'left_voluntary', 'promoted_admin', 'demoted_member');--> statement-breakpoint
CREATE TYPE "public"."group_participant_leave_reason" AS ENUM('removed_by_admin', 'left_voluntarily', 'manual_enforcement', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."group_participant_role" AS ENUM('member', 'admin', 'owner');--> statement-breakpoint
CREATE TYPE "public"."group_participant_status" AS ENUM('active', 'left');--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'whatsapp.ingest_participant_event';--> statement-breakpoint
CREATE TABLE "group_participant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_participant_id" uuid,
	"group_external_id" text NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"event_type" "group_participant_event_type" NOT NULL,
	"target_phone" text,
	"target_sender_external_id" text,
	"target_wa_id" text,
	"actor_phone" text,
	"actor_sender_external_id" text,
	"source_webhook_message_id" text,
	"source_notification" text,
	"raw_payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"messaging_group_id" uuid,
	"group_external_id" text NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"phone" text,
	"sender_external_id" text,
	"wa_id" text,
	"display_name" text,
	"user_id" text,
	"professional_id" text,
	"firebase_uid" text,
	"role" "group_participant_role" DEFAULT 'member' NOT NULL,
	"status" "group_participant_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"leave_reason" "group_participant_leave_reason",
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_participants_identifier_present" CHECK ("group_participants"."phone" IS NOT NULL OR "group_participants"."sender_external_id" IS NOT NULL OR "group_participants"."wa_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "group_participant_events" ADD CONSTRAINT "group_participant_events_group_participant_id_group_participants_id_fk" FOREIGN KEY ("group_participant_id") REFERENCES "public"."group_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_participants" ADD CONSTRAINT "group_participants_messaging_group_id_messaging_groups_id_fk" FOREIGN KEY ("messaging_group_id") REFERENCES "public"."messaging_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_participant_events_dedupe_idx" ON "group_participant_events" USING btree ("source_webhook_message_id","event_type","target_phone","target_sender_external_id");--> statement-breakpoint
CREATE INDEX "group_participant_events_group_occurred_at_idx" ON "group_participant_events" USING btree ("group_external_id","occurred_at");--> statement-breakpoint
CREATE INDEX "group_participant_events_participant_idx" ON "group_participant_events" USING btree ("group_participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_participants_unique_phone_idx" ON "group_participants" USING btree ("group_external_id","protocol","phone") WHERE "group_participants"."phone" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_participants_unique_external_id_idx" ON "group_participants" USING btree ("group_external_id","protocol","sender_external_id") WHERE "group_participants"."sender_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "group_participants_group_status_idx" ON "group_participants" USING btree ("messaging_group_id","status");--> statement-breakpoint
CREATE INDEX "group_participants_user_id_idx" ON "group_participants" USING btree ("user_id") WHERE "group_participants"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "group_participants_professional_id_idx" ON "group_participants" USING btree ("professional_id") WHERE "group_participants"."professional_id" IS NOT NULL;