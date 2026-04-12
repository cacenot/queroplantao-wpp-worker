import { env } from "../config/env.ts";

if (!env.SPAM_FILTERS) {
  console.error("Variável obrigatória: SPAM_FILTERS (ex: SPAM_FILTERS=texto1,texto2,texto3)");
  process.exit(1);
}

const filters = env.SPAM_FILTERS.split(",")
  .map((f) => f.trim())
  .filter(Boolean);

if (filters.length === 0) {
  console.error("SPAM_FILTERS não contém filtros válidos.");
  process.exit(1);
}

const SPAM_INTERVAL_MS = env.SPAM_INTERVAL_MS;

console.log(
  `Spam watcher iniciado. Filtros: [${filters.join(", ")}]. Intervalo: ${SPAM_INTERVAL_MS}ms`
);

while (true) {
  console.log(`[${new Date().toISOString()}] Executando remove-spam...`);

  const proc = Bun.spawn(["bun", "run", "src/scripts/remove-spam.ts", ...filters], {
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;

  console.log(`[${new Date().toISOString()}] Próxima execução em ${SPAM_INTERVAL_MS}ms...`);
  await Bun.sleep(SPAM_INTERVAL_MS);
}
