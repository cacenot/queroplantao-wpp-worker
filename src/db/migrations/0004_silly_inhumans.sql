CREATE TYPE "public"."message_moderation_source" AS ENUM('fresh', 'cached');--> statement-breakpoint
CREATE TYPE "public"."message_moderation_status" AS ENUM('pending', 'skipped', 'analyzed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'whatsapp.moderate_group_message';--> statement-breakpoint
CREATE TABLE "group_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_dedupe_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"provider_instance_id" uuid,
	"group_external_id" text NOT NULL,
	"messaging_group_id" uuid,
	"sender_phone" text,
	"sender_external_id" text,
	"sender_name" text,
	"external_message_id" text NOT NULL,
	"reference_external_message_id" text,
	"message_type" text NOT NULL,
	"message_subtype" text,
	"has_text" boolean NOT NULL,
	"normalized_text" text,
	"media_url" text,
	"thumbnail_url" text,
	"mime_type" text,
	"caption" text,
	"sent_at" timestamp with time zone NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"is_forwarded" boolean DEFAULT false NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL,
	"moderation_status" "message_moderation_status" DEFAULT 'pending' NOT NULL,
	"current_moderation_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_messages_zapi" (
	"group_message_id" uuid PRIMARY KEY NOT NULL,
	"zapi_instance_external_id" text NOT NULL,
	"connected_phone" text,
	"chat_name" text,
	"status" text,
	"sender_lid" text,
	"waiting_message" boolean,
	"view_once" boolean,
	"extracted_payload" jsonb,
	"raw_payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_message_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"moderation_version" text NOT NULL,
	"model" text NOT NULL,
	"source" "message_moderation_source" NOT NULL,
	"source_moderation_id" uuid,
	"status" "message_moderation_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"partner" text,
	"category" text,
	"confidence" numeric(3, 2),
	"action" text,
	"raw_result" jsonb,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messaging_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"name" text NOT NULL,
	"invite_url" text,
	"image_url" text,
	"country" text,
	"uf" text,
	"region" text,
	"city" text,
	"specialties" jsonb,
	"categories" jsonb,
	"participant_count" integer,
	"is_community_visible" boolean,
	"metadata" jsonb,
	"source_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_messaging_group_id_messaging_groups_id_fk" FOREIGN KEY ("messaging_group_id") REFERENCES "public"."messaging_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_current_moderation_id_message_moderations_id_fk" FOREIGN KEY ("current_moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages_zapi" ADD CONSTRAINT "group_messages_zapi_group_message_id_group_messages_id_fk" FOREIGN KEY ("group_message_id") REFERENCES "public"."group_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_moderations" ADD CONSTRAINT "message_moderations_group_message_id_group_messages_id_fk" FOREIGN KEY ("group_message_id") REFERENCES "public"."group_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_moderations" ADD CONSTRAINT "message_moderations_source_moderation_id_message_moderations_id_fk" FOREIGN KEY ("source_moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_messages_ingestion_dedupe_hash_idx" ON "group_messages" USING btree ("ingestion_dedupe_hash");--> statement-breakpoint
CREATE INDEX "group_messages_content_hash_idx" ON "group_messages" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "group_messages_group_protocol_sent_at_idx" ON "group_messages" USING btree ("protocol","group_external_id","sent_at");--> statement-breakpoint
CREATE INDEX "group_messages_moderation_status_idx" ON "group_messages" USING btree ("moderation_status","created_at");--> statement-breakpoint
CREATE INDEX "group_messages_zapi_instance_external_id_idx" ON "group_messages_zapi" USING btree ("zapi_instance_external_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_moderations_group_message_version_idx" ON "message_moderations" USING btree ("group_message_id","moderation_version");--> statement-breakpoint
CREATE INDEX "message_moderations_reuse_lookup_idx" ON "message_moderations" USING btree ("content_hash","moderation_version","status","created_at");--> statement-breakpoint
CREATE INDEX "message_moderations_category_created_at_idx" ON "message_moderations" USING btree ("category","created_at");--> statement-breakpoint
CREATE INDEX "message_moderations_action_created_at_idx" ON "message_moderations" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_groups_external_id_idx" ON "messaging_groups" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "messaging_groups_protocol_idx" ON "messaging_groups" USING btree ("protocol");