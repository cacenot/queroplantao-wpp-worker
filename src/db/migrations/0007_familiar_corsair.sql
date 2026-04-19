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
CREATE UNIQUE INDEX "moderation_configs_active_idx" ON "moderation_configs" USING btree ("is_active") WHERE "moderation_configs"."is_active" = true;