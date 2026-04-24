import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../config/env.ts";

const sql = postgres(env.DATABASE_URL, { max: 1 });
const db = drizzle(sql);

console.log("Aplicando migrações...");
await migrate(db, { migrationsFolder: "src/db/migrations" });
console.log("Migrações aplicadas com sucesso.");

await sql.end();
