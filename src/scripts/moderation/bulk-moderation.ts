import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModel } from "../../ai/model.ts";
import { classifyMessage } from "../../ai/moderator.ts";

// ---------------------------------------------------------------------------
// ANSI helpers (shared with test-moderation.ts pattern)
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  white: "\x1b[97m",
};

const bold = (s: string) => `${c.bold}${s}${c.reset}`;
const dim = (s: string) => `${c.dim}${s}${c.reset}`;
const green = (s: string) => `${c.green}${s}${c.reset}`;
const yellow = (s: string) => `${c.yellow}${s}${c.reset}`;
const red = (s: string) => `${c.red}${s}${c.reset}`;
const cyan = (s: string) => `${c.cyan}${s}${c.reset}`;

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

const BAR_WIDTH = 30;

function renderProgress(done: number, total: number, errors: number) {
  const pct = total === 0 ? 1 : done / total;
  const filled = Math.round(pct * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = `${c.cyan}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
  const pctStr = bold(`${String(Math.round(pct * 100)).padStart(3)}%`);
  const errStr = errors > 0 ? red(`  ${errors} erro(s)`) : "";
  process.stdout.write(
    `\r  ${bar} ${pctStr}  ${dim(String(done).padStart(String(total).length))}/${dim(String(total))}${errStr}   `
  );
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function parseMessagesCsv(content: string): string[] {
  // RFC 4180 single-column parser — handles multiline quoted fields correctly.
  // Iterates character-by-character to correctly track quoted boundaries.
  const fields: string[] = [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let i = 0;

  while (i < normalized.length) {
    let field = "";

    if (normalized[i] === '"') {
      // Quoted field — consume until closing unescaped quote
      i++; // skip opening quote
      while (i < normalized.length) {
        if (normalized[i] === '"') {
          if (normalized[i + 1] === '"') {
            // Escaped quote ""
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += normalized[i];
          i++;
        }
      }
    } else {
      // Unquoted field — read until newline or end
      while (i < normalized.length && normalized[i] !== "\n") {
        field += normalized[i];
        i++;
      }
      field = field.trim();
    }

    fields.push(field);

    // Skip newline separator between rows
    if (normalized[i] === "\n") i++;
  }

  if (fields.length === 0) return [];

  // Skip header row if it is literally "message"
  const start = fields[0]?.trim().toLowerCase() === "message" ? 1 : 0;

  return fields.slice(start).filter((f) => f.length > 0);
}

function escapeCsvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Row {
  message: string;
  action: string;
  category: string;
  confidence: string;
  reason: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CONCURRENCY = 20;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    `\n  ${red(bold("Uso:"))} bun run test-moderation-bulk <caminho/para/arquivo.csv>\n`
  );
  process.exit(1);
}

const csvPath = args[0] as string;
const modelString = process.env.AI_MODEL_ANALYZE_MESSAGE ?? "openai/gpt-4o-mini";

// Read input
let inputContent: string;
try {
  inputContent = await Bun.file(csvPath).text();
} catch {
  console.error(`\n  ${red(bold("Erro:"))} Arquivo não encontrado: ${csvPath}\n`);
  process.exit(1);
}

const messages = parseMessagesCsv(inputContent);
if (messages.length === 0) {
  console.error(`\n  ${red(bold("Erro:"))} Nenhuma mensagem encontrada no CSV.\n`);
  process.exit(1);
}

// Setup output path
const scriptDir = new URL(".", import.meta.url).pathname;
const outputDir = join(scriptDir, "output");
await mkdir(outputDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outputPath = join(outputDir, `output_${timestamp}.csv`);

// Print header
console.log();
console.log(`  ${cyan(bold("Quero Plantão — Bulk Moderation"))}`);
console.log(`  ${"─".repeat(50)}`);
console.log(`  ${dim("Modelo  ")} ${cyan(modelString)}`);
console.log(`  ${dim("Input   ")} ${csvPath}`);
console.log(`  ${dim("Total   ")} ${bold(String(messages.length))} mensagens`);
console.log(`  ${dim("Output  ")} ${outputPath}`);
console.log(`  ${"─".repeat(50)}`);
console.log();

const model = createModel(modelString);

// Process in batches of CONCURRENCY
const rows: Row[] = new Array(messages.length);
let done = 0;
let errors = 0;

renderProgress(0, messages.length, 0);

for (let batchStart = 0; batchStart < messages.length; batchStart += CONCURRENCY) {
  const batchEnd = Math.min(batchStart + CONCURRENCY, messages.length);
  const batch = messages.slice(batchStart, batchEnd);

  await Promise.all(
    batch.map(async (message, i) => {
      const idx = batchStart + i;
      try {
        const result = await classifyMessage(message, model);
        rows[idx] = {
          message,
          action: result.action,
          category: result.category,
          confidence: result.confidence.toFixed(2),
          reason: result.reason,
          error: "",
        };
      } catch (err) {
        errors++;
        rows[idx] = {
          message,
          action: "",
          category: "",
          confidence: "",
          reason: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      done++;
      renderProgress(done, messages.length, errors);
    })
  );
}

// Write CSV output
const headers = ["message", "action", "category", "confidence", "reason", "error"];
const csvLines = [
  headers.join(","),
  ...rows.map((row) =>
    [row.message, row.action, row.category, row.confidence, row.reason, row.error]
      .map(escapeCsvField)
      .join(",")
  ),
];
await Bun.write(outputPath, `${csvLines.join("\n")}\n`);

// Summary
const successful = rows.filter((r) => r.action !== "").length;
const actionCounts = { allow: 0, remove: 0, ban: 0 };
for (const row of rows) {
  if (row.action === "allow") actionCounts.allow++;
  else if (row.action === "remove") actionCounts.remove++;
  else if (row.action === "ban") actionCounts.ban++;
}

console.log("\n");
console.log(`  ${"─".repeat(50)}`);
console.log(
  `  ${bold("Concluído!")}  ${dim(String(successful))}/${bold(String(messages.length))} processadas`
);
console.log();
console.log(
  `  ${green("✅ allow")}   ${bold(String(actionCounts.allow).padStart(4))}  ${dim(`${String(Math.round((actionCounts.allow / messages.length) * 100))}%`)}`
);
console.log(
  `  ${yellow("⚠️  remove")}  ${bold(String(actionCounts.remove).padStart(4))}  ${dim(`${String(Math.round((actionCounts.remove / messages.length) * 100))}%`)}`
);
console.log(
  `  ${red("🚫 ban")}     ${bold(String(actionCounts.ban).padStart(4))}  ${dim(`${String(Math.round((actionCounts.ban / messages.length) * 100))}%`)}`
);
if (errors > 0) {
  console.log(`  ${red("❌ erro")}    ${bold(String(errors).padStart(4))}`);
}
console.log();
console.log(`  ${dim("Salvo em")} ${c.white}${outputPath}${c.reset}`);
console.log();
