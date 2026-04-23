ALTER TABLE "phone_policies" DROP CONSTRAINT "phone_policies_identifier_present";--> statement-breakpoint
ALTER TABLE "phone_policies" ADD COLUMN "wa_id" text;--> statement-breakpoint
CREATE INDEX "phone_policies_wa_id_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","wa_id") WHERE "phone_policies"."wa_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_policies" ADD CONSTRAINT "phone_policies_identifier_present" CHECK ("phone_policies"."phone" IS NOT NULL OR "phone_policies"."sender_external_id" IS NOT NULL OR "phone_policies"."wa_id" IS NOT NULL);