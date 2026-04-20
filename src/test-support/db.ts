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
      'whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.moderate_group_message'
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
    CREATE TABLE "${schemaName}"."moderation_configs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "version" text NOT NULL UNIQUE,
      "primary_model" text NOT NULL,
      "escalation_model" text,
      "escalation_threshold" numeric(3, 2),
      "escalation_categories" text[] NOT NULL DEFAULT '{}'::text[],
      "system_prompt" text NOT NULL,
      "examples" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "is_active" boolean NOT NULL DEFAULT false,
      "content_hash" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "activated_at" timestamp with time zone
    );
    CREATE UNIQUE INDEX "moderation_configs_active_idx_${schemaName}"
      ON "${schemaName}"."moderation_configs" ("is_active")
      WHERE "is_active" = true;
    CREATE TABLE "${schemaName}"."phone_policies" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "protocol" "${schemaName}"."messaging_protocol" NOT NULL,
      "kind" "${schemaName}"."phone_policy_kind" NOT NULL,
      "phone" text,
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
        CHECK ("phone" IS NOT NULL OR "sender_external_id" IS NOT NULL)
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
