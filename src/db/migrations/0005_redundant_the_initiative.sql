DROP INDEX "messaging_groups_external_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_groups_external_id_protocol_idx" ON "messaging_groups" USING btree ("external_id","protocol");