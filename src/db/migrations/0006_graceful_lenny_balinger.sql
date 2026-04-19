DELETE FROM "tasks" WHERE "type"::text = 'whatsapp.analyze_message';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."task_type";--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.moderate_group_message');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "type" SET DATA TYPE "public"."task_type" USING "type"::"public"."task_type";