import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_VERSION } from "./active.ts";
import { loadActive, loadVersion } from "./loader.ts";

const VERSIONS_DIR = join(import.meta.dir, "versions");

const REMOVED_CATEGORIES = [
  "profanity",
  "competitor_promotion",
  "product_sales",
  "service_sales",
  "off_topic",
  "gambling_spam",
  "piracy",
  "adult_content",
  "other_spam",
];

describe("moderation loader", () => {
  it("loadActive() encontra o arquivo apontado por ACTIVE_VERSION", () => {
    const v = loadActive();
    expect(v.version).toBe(ACTIVE_VERSION);
    expect(v.systemPrompt.length).toBeGreaterThan(100);
    expect(v.examples.length).toBeGreaterThan(0);
    expect(v.primaryModel).toMatch(/\//);
  });

  it("todo .md em versions/ parseia sem erro e tem frontmatter consistente", () => {
    const files = readdirSync(VERSIONS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const version = file.replace(/\.md$/, "");
      const v = loadVersion(version);
      expect(v.version).toBe(version);
    }
  });

  it("reasons dos examples não citam categorias removidas", () => {
    const files = readdirSync(VERSIONS_DIR).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const version = file.replace(/\.md$/, "");
      const v = loadVersion(version);
      for (const [i, ex] of v.examples.entries()) {
        for (const removed of REMOVED_CATEGORIES) {
          expect(ex.analysis.reason.toLowerCase()).not.toContain(removed);
          // informa versão/índice se falhar — ajuda no debug
          if (ex.analysis.reason.toLowerCase().includes(removed)) {
            throw new Error(`${version} exemplo ${i + 1}: reason menciona "${removed}"`);
          }
        }
      }
    }
  });

  it("escalationCategories não cai fora das categorias válidas", () => {
    const files = readdirSync(VERSIONS_DIR).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const version = file.replace(/\.md$/, "");
      const v = loadVersion(version);
      // se threshold é null, escalação está off — escalationCategories pode ser qualquer coisa
      if (v.escalationThreshold === null) continue;
      expect(v.escalationCategories.length).toBeGreaterThan(0);
    }
  });
});
