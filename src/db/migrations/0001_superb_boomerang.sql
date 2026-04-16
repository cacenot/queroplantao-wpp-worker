CREATE TYPE "public"."task_status" AS ENUM('pending', 'queued', 'running', 'succeeded', 'failed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.analyze_message');--> statement-breakpoint
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
CREATE INDEX "tasks_status_created_at_idx" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_type_status_idx" ON "tasks" USING btree ("type","status");