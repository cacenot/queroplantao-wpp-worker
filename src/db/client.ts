import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.ts";
import * as schema from "./schema/index.ts";

export type Sql = ReturnType<typeof postgres>;

export function createDbConnection(opts: { max?: number } = {}): Sql {
  return postgres(env.DATABASE_URL, opts);
}

export function createDrizzleDb(sql: Sql) {
  return drizzle(sql, { schema });
}

export type Db = ReturnType<typeof createDrizzleDb>;
