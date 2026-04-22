import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyTiered } from "../../ai/classify-tiered.ts";
import { createModelRegistry } from "../../ai/model-registry.ts";
import { loadActive } from "../../ai/moderation/loader.ts";

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function renderProgress(
  done: number,
  total: number,
  errors: number,
  promptTokens: number,
  completionTokens: number
) {
  const pct = total === 0 ? 1 : done / total;
  const filled = Math.round(pct * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = `${c.cyan}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
  const pctStr = bold(`${String(Math.round(pct * 100)).padStart(3)}%`);
  const tokStr =
    promptTokens + completionTokens > 0
      ? dim(`  ↑${formatTokens(promptTokens)} ↓${formatTokens(completionTokens)} tok`)
      : "";
  const errStr = errors > 0 ? red(`  ${errors} erro(s)`) : "";
  process.stdout.write(
    `\r  ${bar} ${pctStr}  ${dim(String(done).padStart(String(total).length))}/${dim(String(total))}${tokStr}${errStr}   `
  );
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  throw lastError;
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
  partner: string;
  category: string;
  confidence: string;
  reason: string;
  modelUsed: string;
  escalated: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CONCURRENCY = 5;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    `\n  ${red(bold("Uso:"))} bun run test-moderation-bulk <caminho/para/arquivo.csv>\n`
  );
  process.exit(1);
}

const csvPath = args[0] as string;

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

const config = loadActive();
const modelRegistry = createModelRegistry();

// Print header
console.log();
console.log(`  ${cyan(bold("Quero Plantão — Bulk Moderation"))}`);
console.log(`  ${"─".repeat(50)}`);
console.log(`  ${dim("Primary ")} ${cyan(config.primaryModel)}`);
if (config.escalationModel) {
  console.log(
    `  ${dim("Escalate")} ${cyan(config.escalationModel)} (threshold ${config.escalationThreshold})`
  );
}
console.log(`  ${dim("Input   ")} ${csvPath}`);
console.log(`  ${dim("Total   ")} ${bold(String(messages.length))} mensagens`);
console.log(`  ${dim("Output  ")} ${outputPath}`);
console.log(`  ${"─".repeat(50)}`);
console.log();

// Process in batches of CONCURRENCY
const rows: Row[] = new Array(messages.length);
let done = 0;
let errors = 0;
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

renderProgress(0, messages.length, 0, 0, 0);

for (let batchStart = 0; batchStart < messages.length; batchStart += CONCURRENCY) {
  const batchEnd = Math.min(batchStart + CONCURRENCY, messages.length);
  const batch = messages.slice(batchStart, batchEnd);

  await Promise.all(
    batch.map(async (message, i) => {
      const idx = batchStart + i;
      try {
        const result = await withRetry(() =>
          classifyTiered(message, {
            primaryModel: modelRegistry.getModel(config.primaryModel),
            primaryModelString: config.primaryModel,
            escalationModel: config.escalationModel
              ? modelRegistry.getModel(config.escalationModel)
              : null,
            escalationModelString: config.escalationModel,
            escalationThreshold: config.escalationThreshold,
            escalationCategories: config.escalationCategories,
            systemPrompt: config.systemPrompt,
            examples: config.examples,
          })
        );
        totalPromptTokens += result.usage.promptTokens;
        totalCompletionTokens += result.usage.completionTokens;
        rows[idx] = {
          message,
          action: result.analysis.action,
          partner: result.analysis.partner ?? "",
          category: result.analysis.category,
          confidence: result.analysis.confidence.toFixed(2),
          reason: result.analysis.reason,
          modelUsed: result.modelUsed,
          escalated: result.escalated ? "true" : "false",
          error: "",
        };
      } catch (err) {
        errors++;
        rows[idx] = {
          message,
          action: "",
          partner: "",
          category: "",
          confidence: "",
          reason: "",
          modelUsed: "",
          escalated: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      done++;
      renderProgress(done, messages.length, errors, totalPromptTokens, totalCompletionTokens);
    })
  );
}

// Write CSV output
const headers = [
  "message",
  "action",
  "partner",
  "category",
  "confidence",
  "reason",
  "model_used",
  "escalated",
  "error",
];
const csvLines = [
  headers.join(","),
  ...rows.map((row) =>
    [
      row.message,
      row.action,
      row.partner,
      row.category,
      row.confidence,
      row.reason,
      row.modelUsed,
      row.escalated,
      row.error,
    ]
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
console.log(
  `  ${dim("Tokens  ")} ↑ ${bold(formatTokens(totalPromptTokens))} prompt  ↓ ${bold(formatTokens(totalCompletionTokens))} completion  ${dim(`(total ${formatTokens(totalPromptTokens + totalCompletionTokens)})`)}`
);
console.log();
console.log(`  ${dim("Salvo em")} ${c.white}${outputPath}${c.reset}`);
console.log();
