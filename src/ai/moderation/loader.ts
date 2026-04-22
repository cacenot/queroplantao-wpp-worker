import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CATEGORIES } from "../categories.ts";
import type { ClassifyExample, MessageAnalysis } from "../moderator.ts";
import { ACTIVE_VERSION } from "./active.ts";

const PARTNERS = ["quero-plantao", "inbram", "dgs"] as const;
const ACTIONS = ["allow", "remove", "ban"] as const;

const frontmatterSchema = z.object({
  version: z.string().min(1),
  primaryModel: z.string().min(1),
  escalationModel: z.string().min(1).nullable().default(null),
  escalationThreshold: z.number().min(0).max(1).nullable().default(null),
  escalationCategories: z.array(z.enum(CATEGORIES)).default([]),
});

export type ModerationVersion = {
  version: string;
  primaryModel: string;
  escalationModel: string | null;
  escalationThreshold: number | null;
  escalationCategories: readonly (typeof CATEGORIES)[number][];
  systemPrompt: string;
  examples: ClassifyExample[];
};

const VERSIONS_DIR = join(import.meta.dir, "versions");

export function loadActive(): ModerationVersion {
  return loadVersion(ACTIVE_VERSION);
}

export function loadVersion(version: string): ModerationVersion {
  const path = join(VERSIONS_DIR, `${version}.md`);
  const raw = readFileSync(path, "utf-8");
  return parseVersion(raw, version);
}

export function parseVersion(raw: string, expectedVersion?: string): ModerationVersion {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch?.[1] || fmMatch[2] === undefined) {
    throw new Error("Arquivo sem frontmatter YAML delimitado por ---");
  }
  const yamlText = fmMatch[1];
  const body = fmMatch[2];

  const parsed = frontmatterSchema.parse(Bun.YAML.parse(yamlText));
  if (expectedVersion && parsed.version !== expectedVersion) {
    throw new Error(
      `Frontmatter version "${parsed.version}" não bate com nome do arquivo "${expectedVersion}"`
    );
  }

  const systemPrompt = extractSection(body, "System Prompt");
  const examples = parseExamples(extractSection(body, "Exemplos"));

  return { ...parsed, systemPrompt, examples };
}

function extractSection(body: string, name: string): string {
  const parts = body.split(/^# /m);
  for (const part of parts) {
    if (part.startsWith(`${name}\n`) || part === `${name}\n` || part.startsWith(`${name}\r\n`)) {
      return part.slice(name.length).trim();
    }
  }
  throw new Error(`Seção "# ${name}" não encontrada`);
}

function parseExamples(body: string): ClassifyExample[] {
  const blocks = body.split(/^## /m).slice(1);
  return blocks.map((block, i) => parseExampleBlock(block, i + 1));
}

function parseExampleBlock(block: string, expectedIdx: number): ClassifyExample {
  const firstNewline = block.indexOf("\n");
  if (firstNewline === -1) throw new Error(`Exemplo ${expectedIdx}: cabeçalho sem corpo`);
  const header = block.slice(0, firstNewline);
  const rest = block.slice(firstNewline + 1);

  const headerMatch = header.match(/^(\d+) · (\w+) \/ (\w+)(?: · ([\w-]+))?\s*$/);
  if (!headerMatch?.[1] || !headerMatch[2] || !headerMatch[3]) {
    throw new Error(`Exemplo ${expectedIdx}: cabeçalho inválido: "${header}"`);
  }
  const idx = Number(headerMatch[1]);
  const category = headerMatch[2];
  const action = headerMatch[3];
  const partnerRaw = headerMatch[4];
  if (idx !== expectedIdx) {
    throw new Error(`Exemplo ${expectedIdx}: índice no cabeçalho é ${idx}`);
  }

  const codeblock = rest.match(/^(`{3,})input[ \t]*\n([\s\S]*?)\n\1[ \t]*$/m);
  if (!codeblock?.[0] || codeblock[2] === undefined) {
    throw new Error(`Exemplo ${idx}: bloco \`\`\`input ausente`);
  }
  const text = codeblock[2];
  const reason = rest.slice(0, rest.indexOf(codeblock[0])).trim();
  if (!reason) throw new Error(`Exemplo ${idx}: reason vazio`);

  const analysis: MessageAnalysis = {
    reason,
    partner: partnerRaw ? assertPartner(partnerRaw, idx) : null,
    category: assertCategory(category, idx),
    confidence: 1,
    action: assertAction(action, idx),
  };
  return { text, analysis };
}

function assertCategory(s: string, idx: number): MessageAnalysis["category"] {
  if ((CATEGORIES as readonly string[]).includes(s)) {
    return s as MessageAnalysis["category"];
  }
  throw new Error(`Exemplo ${idx}: categoria inválida "${s}"`);
}

function assertAction(s: string, idx: number): MessageAnalysis["action"] {
  if ((ACTIONS as readonly string[]).includes(s)) {
    return s as MessageAnalysis["action"];
  }
  throw new Error(`Exemplo ${idx}: action inválida "${s}"`);
}

function assertPartner(s: string, idx: number): MessageAnalysis["partner"] {
  if ((PARTNERS as readonly string[]).includes(s)) {
    return s as MessageAnalysis["partner"];
  }
  throw new Error(`Exemplo ${idx}: partner inválido "${s}"`);
}
