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
      'whatsapp.delete_message', 'whatsapp.remove_participant', 'whatsapp.analyze_message'
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
