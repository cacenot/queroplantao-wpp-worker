CREATE TYPE "public"."messaging_execution_strategy" AS ENUM('leased', 'passthrough');--> statement-breakpoint
CREATE TYPE "public"."messaging_protocol" AS ENUM('whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."messaging_provider_kind" AS ENUM('whatsapp_zapi', 'whatsapp_whatsmeow', 'whatsapp_business_api', 'telegram_bot');--> statement-breakpoint
CREATE TYPE "public"."zapi_connection_event_source" AS ENUM('webhook', 'poll', 'bootstrap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."zapi_connection_state" AS ENUM('unknown', 'connected', 'disconnected', 'pending', 'errored');--> statement-breakpoint
CREATE TYPE "public"."zapi_device_snapshot_source" AS ENUM('api_device', 'webhook', 'bootstrap', 'manual');--> statement-breakpoint
CREATE TABLE "messaging_provider_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"provider_kind" "messaging_provider_kind" NOT NULL,
	"display_name" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"execution_strategy" "messaging_execution_strategy" DEFAULT 'leased' NOT NULL,
	"redis_key" text,
	"cooldown_min_ms" integer,
	"cooldown_max_ms" integer,
	"safety_ttl_ms" integer,
	"heartbeat_interval_ms" integer,
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
	"webhook_base_url" text,
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
ALTER TABLE "zapi_instance_connection_events" ADD CONSTRAINT "zapi_instance_connection_events_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapi_instance_device_snapshots" ADD CONSTRAINT "zapi_instance_device_snapshots_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zapi_instances" ADD CONSTRAINT "zapi_instances_messaging_provider_instance_id_messaging_provider_instances_id_fk" FOREIGN KEY ("messaging_provider_instance_id") REFERENCES "public"."messaging_provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messaging_provider_instances_protocol_enabled_idx" ON "messaging_provider_instances" USING btree ("protocol","is_enabled");--> statement-breakpoint
CREATE INDEX "messaging_provider_instances_provider_kind_idx" ON "messaging_provider_instances" USING btree ("provider_kind");--> statement-breakpoint
CREATE INDEX "zapi_instance_connection_events_provider_instance_idx" ON "zapi_instance_connection_events" USING btree ("messaging_provider_instance_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "zapi_instance_connection_events_dedupe_key_idx" ON "zapi_instance_connection_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "zapi_instance_device_snapshots_provider_instance_idx" ON "zapi_instance_device_snapshots" USING btree ("messaging_provider_instance_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "zapi_instances_zapi_instance_id_idx" ON "zapi_instances" USING btree ("zapi_instance_id");