CREATE TYPE "public"."message_moderation_source" AS ENUM('fresh', 'cached');--> statement-breakpoint
CREATE TYPE "public"."message_moderation_status" AS ENUM('pending', 'skipped', 'analyzed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."phone_policy_kind" AS ENUM('blacklist', 'bypass');--> statement-breakpoint
CREATE TYPE "public"."phone_policy_source" AS ENUM('manual', 'moderation_auto', 'group_admin_sync', 'admin_api_sync');--> statement-breakpoint
CREATE TYPE "public"."messaging_execution_strategy" AS ENUM('leased', 'passthrough');--> statement-breakpoint
CREATE TYPE "public"."messaging_protocol" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."messaging_provider_kind" AS ENUM('whatsapp_zapi', 'whatsapp_whatsmeow', 'whatsapp_business_api', 'telegram_bot');--> statement-breakpoint
CREATE TYPE "public"."zapi_connection_event_source" AS ENUM('webhook', 'poll', 'bootstrap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."zapi_connection_state" AS ENUM('unknown', 'connected', 'disconnected', 'pending', 'errored', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."zapi_device_snapshot_source" AS ENUM('api_device', 'webhook', 'bootstrap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'queued', 'running', 'succeeded', 'failed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.moderate_group_message');--> statement-breakpoint
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
CREATE TABLE "moderation_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"primary_model" text NOT NULL,
	"escalation_model" text,
	"escalation_threshold" numeric(3, 2),
	"escalation_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"system_prompt" text NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "moderation_configs_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "phone_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"kind" "phone_policy_kind" NOT NULL,
	"phone" text,
	"sender_external_id" text,
	"group_external_id" text,
	"source" "phone_policy_source" DEFAULT 'manual' NOT NULL,
	"reason" text,
	"notes" text,
	"moderation_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_policies_identifier_present" CHECK ("phone_policies"."phone" IS NOT NULL OR "phone_policies"."sender_external_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "messaging_provider_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"display_name" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"execution_strategy" "messaging_execution_strategy" DEFAULT 'leased' NOT NULL,
	"redis_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "zapi_instance_connection_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"messaging_provider_instance_id" uuid NOT NULL,
	"source" "zapi_connection_event_source" NOT NULL,
	"event_type" text NOT NULL,
	"connected" boolean,
	"smartphone_connected" boolean,
	"status_reason" text,
	"provider_occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"raw_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zapi_instance_device_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"messaging_provider_instance_id" uuid NOT NULL,
	"source" "zapi_device_snapshot_source" NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phone_number" text,
	"profile_name" text,
	"profile_about" text,
	"profile_image_url" text,
	"original_device" text,
	"session_id" integer,
	"device_session_name" text,
	"device_model" text,
	"is_business" boolean,
	"raw_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zapi_instances" (
	"messaging_provider_instance_id" uuid PRIMARY KEY NOT NULL,
	"zapi_instance_id" text NOT NULL,
	"instance_token" text NOT NULL,
	"custom_client_token" text,
	"current_connection_state" "zapi_connection_state",
	"current_status_reason" text,
	"current_connected" boolean,
	"current_smartphone_connected" boolean,
	"current_phone_number" text,
	"current_profile_name" text,
	"current_profile_about" text,
	"current_profile_image_url" text,
	"current_original_device" text,
	"current_session_id" integer,
	"current_device_session_name" text,
	"current_device_model" text,
	"current_is_business" boolean,
	"last_status_synced_at" timestamp with time zone,
	"last_device_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "task_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_messaging_group_id_messaging_groups_id_fk" FOREIGN KEY ("messaging_group_id") REFERENCES "public"."messaging_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_current_moderation_id_message_moderations_id_fk" FOREIGN KEY ("current_moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages_zapi" ADD CONSTRAINT "group_messages_zapi_group_message_id_group_messages_id_fk" FOREIGN KEY ("group_message_id") REFERENCES "public"."group_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_moderations" ADD CONSTRAINT "message_moderations_group_message_id_group_messages_id_fk" FOREIGN KEY ("group_message_id") REFERENCES "public"."group_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_moderations" ADD CONSTRAINT "message_moderations_source_moderation_id_message_moderations_id_fk" FOREIGN KEY ("source_moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_policies" ADD CONSTRAINT "phone_policies_moderation_id_message_moderations_id_fk" FOREIGN KEY ("moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapi_instance_connection_events" ADD CONSTRAINT "zapi_instance_connection_events_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapi_instance_device_snapshots" ADD CONSTRAINT "zapi_instance_device_snapshots_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapi_instances" ADD CONSTRAINT "zapi_instances_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_messages_ingestion_dedupe_hash_idx" ON "group_messages" USING btree ("ingestion_dedupe_hash");--> statement-breakpoint
CREATE INDEX "group_messages_content_hash_idx" ON "group_messages" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "group_messages_group_protocol_sent_at_idx" ON "group_messages" USING btree ("protocol","group_external_id","sent_at");--> statement-breakpoint
CREATE INDEX "group_messages_moderation_status_idx" ON "group_messages" USING btree ("moderation_status","created_at");--> statement-breakpoint
CREATE INDEX "group_messages_zapi_instance_external_id_idx" ON "group_messages_zapi" USING btree ("zapi_instance_external_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_moderations_group_message_version_idx" ON "message_moderations" USING btree ("group_message_id","moderation_version");--> statement-breakpoint
CREATE INDEX "message_moderations_reuse_lookup_idx" ON "message_moderations" USING btree ("content_hash","moderation_version","status","created_at");--> statement-breakpoint
CREATE INDEX "message_moderations_category_created_at_idx" ON "message_moderations" USING btree ("category","created_at");--> statement-breakpoint
CREATE INDEX "message_moderations_action_created_at_idx" ON "message_moderations" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_groups_external_id_protocol_idx" ON "messaging_groups" USING btree ("external_id","protocol");--> statement-breakpoint
CREATE INDEX "messaging_groups_protocol_idx" ON "messaging_groups" USING btree ("protocol");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_configs_active_idx" ON "moderation_configs" USING btree ("is_active") WHERE "moderation_configs"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_policies_unique_phone_idx" ON "phone_policies" USING btree ("protocol","kind","phone",COALESCE("group_external_id", '')) WHERE "phone_policies"."phone" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_policies_unique_external_id_idx" ON "phone_policies" USING btree ("protocol","kind","sender_external_id",COALESCE("group_external_id", '')) WHERE "phone_policies"."sender_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_policies_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","phone") WHERE "phone_policies"."phone" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_policies_external_id_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","sender_external_id") WHERE "phone_policies"."sender_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_policies_expires_at_idx" ON "phone_policies" USING btree ("expires_at") WHERE "phone_policies"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messaging_provider_instances_protocol_enabled_idx" ON "messaging_provider_instances" USING btree ("protocol","is_enabled");--> statement-breakpoint
CREATE INDEX "messaging_provider_instances_provider_kind_idx" ON "messaging_provider_instances" USING btree ("provider_kind");--> statement-breakpoint
CREATE INDEX "zapi_instance_connection_events_provider_instance_idx" ON "zapi_instance_connection_events" USING btree ("messaging_provider_instance_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "zapi_instance_connection_events_dedupe_key_idx" ON "zapi_instance_connection_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "zapi_instance_device_snapshots_provider_instance_idx" ON "zapi_instance_device_snapshots" USING btree ("messaging_provider_instance_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "zapi_instances_zapi_instance_id_idx" ON "zapi_instances" USING btree ("zapi_instance_id");--> statement-breakpoint
CREATE INDEX "tasks_status_created_at_idx" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_type_status_idx" ON "tasks" USING btree ("type","status");