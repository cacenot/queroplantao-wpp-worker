DROP INDEX "phone_policies_unique_idx";--> statement-breakpoint
DROP INDEX "phone_policies_lookup_idx";--> statement-breakpoint
ALTER TABLE "phone_policies" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_policies" ADD COLUMN "sender_external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_policies_unique_phone_idx" ON "phone_policies" USING btree ("protocol","kind","phone",COALESCE("group_external_id", '')) WHERE "phone_policies"."phone" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_policies_unique_external_id_idx" ON "phone_policies" USING btree ("protocol","kind","sender_external_id",COALESCE("group_external_id", '')) WHERE "phone_policies"."sender_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_policies_external_id_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","sender_external_id") WHERE "phone_policies"."sender_external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "phone_policies_lookup_idx" ON "phone_policies" USING btree ("protocol","kind","phone") WHERE "phone_policies"."phone" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_policies" ADD CONSTRAINT "phone_policies_identifier_present" CHECK ("phone_policies"."phone" IS NOT NULL OR "phone_policies"."sender_external_id" IS NOT NULL);