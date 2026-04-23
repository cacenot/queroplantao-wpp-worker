import { toE164 } from "../lib/phone.ts";
import {
  AllowlistConflictError,
  InvalidPhoneError,
  PhoneFilterTooShortError,
} from "../services/group-messages-removal/index.ts";
import {
  buildRemovalRunner,
  formatPreview,
  formatResult,
  parseFlagArgs,
  promptYesNo,
} from "./_removal-runner.ts";

const rawPhone = process.argv[2];
const phone = rawPhone ? toE164(rawPhone) : null;
const { allDays, limit } = parseFlagArgs(process.argv.slice(3));

if (!phone) {
  console.error("Uso: bun run src/scripts/remove-by-phone.ts <telefone> [limit] [all]");
  console.error('Exemplo: bun run src/scripts/remove-by-phone.ts "5511999999999" 100');
  console.error('         bun run src/scripts/remove-by-phone.ts "+55 11 99999-9999" all');
  console.error('         bun run src/scripts/remove-by-phone.ts "5511999999999" 100 all');
  console.error("telefone precisa ser formatável como E.164 (aceita com/sem +, com/sem máscara).");
  console.error(
    "limit=0 (default) processa todas as mensagens. all = sem filtro de data (default: somente hoje)."
  );
  process.exit(1);
}

const { service, close } = await buildRemovalRunner();

try {
  const preview = await service.previewByPhone({ phone, options: { allDays, limit } });

  if (preview.allowlistConflict) {
    console.error(`Phone está em allowlist (policy ${preview.allowlistConflict.policyId}).`);
    console.error(`  Motivo: ${preview.allowlistConflict.reason ?? "(sem motivo)"}`);
    console.error("  Remova da allowlist antes de rodar.");
    process.exit(2);
  }

  console.log(formatPreview(preview));
  if (preview.blacklistedAlready) {
    console.log("Phone já está na blacklist global.");
  }

  if (preview.messageCount === 0) {
    console.log("Nada a fazer.");
  } else {
    const confirmed = await promptYesNo("Confirmar? (s/N)");
    if (!confirmed) {
      console.log("Abortado.");
    } else {
      const result = await service.executeByPhone({ phone, options: { allDays, limit } });
      console.log(formatResult(result));
    }
  }
} catch (err) {
  if (err instanceof PhoneFilterTooShortError || err instanceof InvalidPhoneError) {
    console.error(`Erro: ${err.message}`);
    process.exit(1);
  }
  if (err instanceof AllowlistConflictError) {
    console.error(`Phone está em allowlist (policy ${err.match.policyId}).`);
    console.error("  Remova da allowlist antes de rodar.");
    process.exit(2);
  }
  throw err;
} finally {
  await close();
}
