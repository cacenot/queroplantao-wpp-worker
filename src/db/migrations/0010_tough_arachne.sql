ALTER TYPE "public"."zapi_connection_state" ADD VALUE 'unreachable';--> statement-breakpoint
ALTER TABLE "zapi_instances" ADD COLUMN "custom_client_token" text;--> statement-breakpoint
ALTER TABLE "messaging_provider_instances" DROP COLUMN "safety_ttl_ms";--> statement-breakpoint
ALTER TABLE "messaging_provider_instances" DROP COLUMN "heartbeat_interval_ms";--> statement-breakpoint
ALTER TABLE "zapi_instances" DROP COLUMN "webhook_base_url";