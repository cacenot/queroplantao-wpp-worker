import { NoFiltersError } from "../services/group-messages-removal/index.ts";
import {
  buildRemovalRunner,
  formatPreview,
  formatResult,
  parseFlagArgs,
  promptYesNo,
} from "./_removal-runner.ts";

const args = process.argv.slice(2);
const { allDays, limit } = parseFlagArgs(args);
const filters = args.filter((a) => a !== "all" && !/^\d+$/.test(a));

if (filters.length === 0) {
  console.error("Uso: bun run src/scripts/remove-spam.ts <filtro1> [filtro2 ...] [limit] [all]");
  console.error('Exemplo: bun run src/scripts/remove-spam.ts "https://tk7.games" 100');
  console.error('         bun run src/scripts/remove-spam.ts "https://tk7.games" "bit.ly" all');
  console.error('         bun run src/scripts/remove-spam.ts "https://tk7.games" 100 all');
  console.error(
    "limit=0 (default) processa todas as mensagens. all = sem filtro de data (default: somente hoje)."
  );
  process.exit(1);
}

const { service, close } = await buildRemovalRunner();

try {
  const preview = await service.previewBySpam({ filters, options: { allDays, limit } });

  console.log(formatPreview(preview));

  if (preview.messageCount === 0) {
    console.log("Nada a fazer.");
  } else {
    const confirmed = await promptYesNo("Confirmar? (s/N)");
    if (!confirmed) {
      console.log("Abortado.");
    } else {
      const result = await service.executeBySpam({ filters, options: { allDays, limit } });
      console.log(formatResult(result));
    }
  }
} catch (err) {
  if (err instanceof NoFiltersError) {
    console.error(`Erro: ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  await close();
}
