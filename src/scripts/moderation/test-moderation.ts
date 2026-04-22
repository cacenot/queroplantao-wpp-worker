import { classifyTiered } from "../../ai/classify-tiered.ts";
import { createModel } from "../../ai/model.ts";
import { loadActive } from "../../ai/moderation/loader.ts";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
};

function bold(s: string) {
  return `${c.bold}${s}${c.reset}`;
}

function dim(s: string) {
  return `${c.dim}${s}${c.reset}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ACTION_STYLE: Record<string, { color: string; icon: string; bg: string }> = {
  allow: { color: c.green, icon: "✅", bg: c.bgGreen },
  remove: { color: c.yellow, icon: "⚠️ ", bg: c.bgYellow },
  ban: { color: c.red, icon: "🚫", bg: c.bgRed },
};

function confidenceBar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  const empty = width - filled;
  const pct = Math.round(value * 100);
  const bar = `${"█".repeat(filled)}${"░".repeat(empty)}`;
  const color = value >= 0.85 ? c.green : value >= 0.6 ? c.yellow : c.red;
  return (
    `${color}${bar}${c.reset} ${bold(`${String(pct)}%`)}`.trim() +
    " ".repeat(Math.max(0, 3 - String(pct).length)) +
    "%".replace("%", "")
  );
}

function separator(width = 60): string {
  return dim("─".repeat(width));
}

type AnalysisSummary = {
  action: string;
  category: string;
  confidence: number;
  reason: string;
};

function printResult(
  text: string,
  modelUsed: string,
  escalated: boolean,
  primary: AnalysisSummary | null,
  final: AnalysisSummary
) {
  const style = ACTION_STYLE[final.action] ?? { color: c.white, icon: "•", bg: "" };

  console.log();
  console.log(`${c.cyan}${bold("  Quero Plantão — Moderator Test")}${c.reset}`);
  console.log(`  ${separator(44)}`);
  console.log();
  console.log(`  ${dim("Modelo  ")}${c.cyan}${modelUsed}${c.reset}`);
  if (escalated && primary) {
    console.log(
      `  ${dim("Escalou ")}${c.yellow}${bold("SIM")}${c.reset} ${dim(
        `(primary: ${primary.category}/${primary.action} ${Math.round(primary.confidence * 100)}%)`
      )}`
    );
  }
  console.log();
  console.log(`  ${dim("Mensagem")}`);
  console.log(`  ${separator(44)}`);
  console.log(`  ${c.white}"${text}"${c.reset}`);
  console.log(`  ${separator(44)}`);
  console.log();
  console.log(
    `  ${dim("Ação     ")}${style.color}${bold(`${style.icon} ${final.action.toUpperCase()}`)}${c.reset}`
  );
  console.log(`  ${dim("Categoria")} ${bold(final.category)}`);
  console.log(`  ${dim("Confiança")} ${confidenceBar(final.confidence)}`);
  console.log();
  console.log(`  ${dim("Motivo")}`);
  console.log(`  ${c.white}${final.reason}${c.reset}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error(`\n  ${c.red}${bold("Uso:")}${c.reset} bun run test-moderation <mensagem>\n`);
  console.error(`  ${dim('Exemplo: bun run test-moderation "Plantão disponível no HU amanhã"')}\n`);
  process.exit(1);
}

const text = args.join(" ");
const config = loadActive();
const primaryModelString = process.env.MODERATION_MODEL ?? config.primaryModel;
const escalationModelString = config.escalationModel;

const escalationLabel = escalationModelString
  ? ` → ${escalationModelString} (≥${config.escalationThreshold})`
  : "";
console.log(
  `\n  ${dim("Classificando...")} ${dim(primaryModelString)}${dim(escalationLabel)} ${dim(`(v=${config.version})`)}`
);

try {
  const result = await classifyTiered(text, {
    primaryModel: createModel(primaryModelString),
    primaryModelString,
    escalationModel: escalationModelString ? createModel(escalationModelString) : null,
    escalationModelString,
    escalationThreshold: config.escalationThreshold,
    escalationCategories: config.escalationCategories,
    systemPrompt: config.systemPrompt,
    examples: config.examples,
  });

  printResult(text, result.modelUsed, result.escalated, result.primaryAnalysis, result.analysis);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${c.red}${bold("Erro:")}${c.reset} ${message}\n`);
  process.exit(1);
}
