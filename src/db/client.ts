import postgres from "postgres";
import { env } from "../config/env.ts";

export type Sql = ReturnType<typeof postgres>;

export function createDbConnection(): Sql {
  return postgres(env.DATABASE_URL);
}
