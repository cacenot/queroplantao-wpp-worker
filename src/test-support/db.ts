import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema/index.ts";

/**
 * Cria um schema Postgres isolado por test suite e instancia Drizzle apontando para ele.
 * O search_path fica restrito ao schema criado, garantindo isolamento.
 *
 * Só as tabelas necessárias para os testes do retry (tasks) são materializadas — provider
 * registry e zapi instances não são necessárias aqui.
 *
 * Use `drop()` em afterAll para limpar e encerrar a conexão.
 */
export async function createTestDb(): Promise<{
  db: ReturnType<typeof drizzle<typeof schema>>;
  sql: ReturnType<typeof postgres>;
  schemaName: string;
  drop: () => Promise<void>;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL é obrigatória para testes de integração (ver docker-compose.yml)"
    );
  }

  const schemaName = `test_${randomUUID().replace(/-/g, "")}`;

  const sql = postgres(databaseUrl, {
    connection: { search_path: schemaName },
  });

  await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
  await sql.unsafe(`SET search_path TO "${schemaName}"`);

  await sql.unsafe(`
    CREATE TYPE "${schemaName}"."task_status" AS ENUM (
      'pending', 'queued', 'running', 'succeeded', 'failed', 'dropped'
    );
    CREATE TYPE "${schemaName}"."task_type" AS ENUM (
      'whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.moderate_group_message',
      'whatsapp.ingest_participant_event'
    );
    CREATE TYPE "${schemaName}"."messaging_protocol" AS ENUM ('whatsapp', 'telegram');
    CREATE TYPE "${schemaName}"."phone_policy_kind" AS ENUM ('blacklist', 'bypass');
    CREATE TYPE "${schemaName}"."phone_policy_source" AS ENUM (
      'manual', 'moderation_auto', 'group_admin_sync', 'admin_api_sync'
    );
    CREATE TABLE "${schemaName}"."tasks" (
      "id" uuid PRIMARY KEY NOT NULL,
      "type" "${schemaName}"."task_type" NOT NULL,
      "payload" jsonb NOT NULL,
      "status" "${schemaName}"."task_status" NOT NULL DEFAULT 'pending',
      "attempt" integer NOT NULL DEFAULT 0,
      "error" jsonb,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "queued_at" timestamp with time zone,
      "started_at" timestamp with time zone,
      "completed_at" timestamp with time zone
    );
    CREATE TABLE "${schemaName}"."phone_policies" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
      "kind" "${schemaName}"."phone_policy_kind" NOT NULL,
      "phone" text,
      "wa_id" text,
      "sender_external_id" text,
      "group_external_id" text,
      "source" "${schemaName}"."phone_policy_source" NOT NULL DEFAULT 'manual',
      "reason" text,
      "notes" text,
      "moderation_id" uuid,
      "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "expires_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "phone_policies_identifier_present_${schemaName}"
        CHECK ("phone" IS NOT NULL OR "sender_external_id" IS NOT NULL OR "wa_id" IS NOT NULL)
    );
    CREATE UNIQUE INDEX "phone_policies_unique_phone_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("protocol", "kind", "phone", COALESCE("group_external_id", ''))
      WHERE "phone" IS NOT NULL;
    CREATE UNIQUE INDEX "phone_policies_unique_external_id_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("protocol", "kind", "sender_external_id", COALESCE("group_external_id", ''))
      WHERE "sender_external_id" IS NOT NULL;
    CREATE INDEX "phone_policies_lookup_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("protocol", "kind", "phone")
      WHERE "phone" IS NOT NULL;
    CREATE INDEX "phone_policies_external_id_lookup_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("protocol", "kind", "sender_external_id")
      WHERE "sender_external_id" IS NOT NULL;
    CREATE INDEX "phone_policies_expires_at_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("expires_at") WHERE "expires_at" IS NOT NULL;
    CREATE INDEX "phone_policies_wa_id_lookup_idx_${schemaName}"
      ON "${schemaName}"."phone_policies" ("protocol", "kind", "wa_id")
      WHERE "wa_id" IS NOT NULL;

    CREATE TYPE "${schemaName}"."messaging_provider_kind" AS ENUM (
      'whatsapp_zapi', 'whatsapp_whatsmeow', 'whatsapp_business_api', 'telegram_bot'
    );
    CREATE TYPE "${schemaName}"."message_moderation_status" AS ENUM (
      'pending', 'skipped', 'analyzed', 'failed'
    );
    CREATE TABLE "${schemaName}"."group_messages" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "ingestion_dedupe_hash" text NOT NULL,
      "content_hash" text NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
      "provider_kind" "${schemaName}"."messaging_provider_kind" NOT NULL,
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
      "from_me" boolean NOT NULL DEFAULT false,
      "is_forwarded" boolean NOT NULL DEFAULT false,
      "is_edited" boolean NOT NULL DEFAULT false,
      "moderation_status" "${schemaName}"."message_moderation_status" NOT NULL DEFAULT 'pending',
      "current_moderation_id" uuid,
      "removed_at" timestamp with time zone,
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "group_messages_ingestion_dedupe_hash_idx_${schemaName}"
      ON "${schemaName}"."group_messages" ("ingestion_dedupe_hash");
    CREATE INDEX "group_messages_external_id_group_idx_${schemaName}"
      ON "${schemaName}"."group_messages" ("external_message_id", "group_external_id");

    CREATE TABLE "${schemaName}"."messaging_groups" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "external_id" text NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
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
      "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "messaging_groups_external_id_protocol_idx_${schemaName}"
      ON "${schemaName}"."messaging_groups" ("external_id", "protocol");

    CREATE TYPE "${schemaName}"."group_participant_role" AS ENUM ('member', 'admin', 'owner');
    CREATE TYPE "${schemaName}"."group_participant_status" AS ENUM ('active', 'left');
    CREATE TYPE "${schemaName}"."group_participant_leave_reason" AS ENUM (
      'removed_by_admin', 'left_voluntarily', 'manual_enforcement', 'unknown'
    );
    CREATE TYPE "${schemaName}"."group_participant_event_type" AS ENUM (
      'joined_add', 'joined_invite_link', 'joined_non_admin_add', 'joined_inferred',
      'left_removed', 'left_voluntary', 'promoted_admin', 'demoted_member'
    );

    CREATE TABLE "${schemaName}"."group_participants" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "messaging_group_id" uuid,
      "group_external_id" text NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
      "provider_kind" "${schemaName}"."messaging_provider_kind" NOT NULL,
      "phone" text,
      "sender_external_id" text,
      "wa_id" text,
      "display_name" text,
      "user_id" text,
      "professional_id" text,
      "firebase_uid" text,
      "role" "${schemaName}"."group_participant_role" NOT NULL DEFAULT 'member',
      "status" "${schemaName}"."group_participant_status" NOT NULL DEFAULT 'active',
      "joined_at" timestamp with time zone,
      "left_at" timestamp with time zone,
      "leave_reason" "${schemaName}"."group_participant_leave_reason",
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_event_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "group_participants_identifier_present_${schemaName}"
        CHECK ("phone" IS NOT NULL OR "sender_external_id" IS NOT NULL OR "wa_id" IS NOT NULL)
    );
    CREATE UNIQUE INDEX "group_participants_unique_phone_idx_${schemaName}"
      ON "${schemaName}"."group_participants" ("group_external_id", "protocol", "phone")
      WHERE "phone" IS NOT NULL;
    CREATE UNIQUE INDEX "group_participants_unique_external_id_idx_${schemaName}"
      ON "${schemaName}"."group_participants" ("group_external_id", "protocol", "sender_external_id")
      WHERE "sender_external_id" IS NOT NULL;

    CREATE TABLE "${schemaName}"."group_participant_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "group_participant_id" uuid,
      "group_external_id" text NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
      "provider_kind" "${schemaName}"."messaging_provider_kind" NOT NULL,
      "event_type" "${schemaName}"."group_participant_event_type" NOT NULL,
      "target_phone" text,
      "target_sender_external_id" text,
      "target_wa_id" text,
      "actor_phone" text,
      "actor_sender_external_id" text,
      "source_webhook_message_id" text,
      "source_notification" text,
      "raw_payload" jsonb,
      "occurred_at" timestamp with time zone NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "group_participant_events_dedupe_idx_${schemaName}"
      ON "${schemaName}"."group_participant_events"
      (COALESCE("source_webhook_message_id", ''), "event_type",
       COALESCE("target_phone", ''), COALESCE("target_sender_external_id", ''));
  `);

  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    schemaName,
    async drop() {
      try {
        await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  };
}
