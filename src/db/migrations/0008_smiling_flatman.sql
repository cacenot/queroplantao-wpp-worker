CREATE TYPE "public"."phone_policy_kind" AS ENUM('blacklist', 'bypass');--> statement-breakpoint
CREATE TYPE "public"."phone_policy_source" AS ENUM('manual', 'moderation_auto', 'group_admin_sync', 'admin_api_sync');--> statement-breakpoint
CREATE TABLE "phone_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol" "messaging_protocol" NOT NULL,
	"kind" "phone_policy_kind" NOT NULL,
	"phone" text NOT NULL,
	"group_external_id" text,
	"source" "phone_policy_source" DEFAULT 'manual' NOT NULL,
	"reason" text,
	"notes" text,
	"moderation_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phone_policies" ADD CONSTRAINT "phone_policies_moderation_id_message_moderations_id_fk" FOREIGN KEY ("moderation_id") REFERENCES "public"."message_moderations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_policies_unique_idx" ON "phone_policies" USING btree ("protocol","kind","phone",COALESCE("group_external_id", ''));--> statement-breakpoint
CREATE INDEX "phone_policies_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","phone");--> statement-breakpoint
CREATE INDEX "phone_policies_expires_at_idx" ON "phone_policies" USING btree ("expires_at") WHERE "phone_policies"."expires_at" IS NOT NULL;