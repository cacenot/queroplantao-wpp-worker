import { describe, expect, it } from "bun:test";
import { computeContentHash, computeIngestionDedupeHash } from "./message-hash.ts";

const WINDOW_MS = 60_000;

function baseParts() {
  return {
    protocol: "whatsapp",
    groupExternalId: "120363-group",
    senderPhone: "5511999999999",
    senderExternalId: "1111:1@lid",
    content: "spam content",
    sentAt: new Date("2026-04-16T12:00:10.000Z"),
  };
}

describe("computeIngestionDedupeHash", () => {
  it("gera o mesmo hash para a mesma mensagem dentro da janela", () => {
    const a = computeIngestionDedupeHash(baseParts(), WINDOW_MS);
    const b = computeIngestionDedupeHash(
      { ...baseParts(), sentAt: new Date("2026-04-16T12:00:50.000Z") },
      WINDOW_MS
    );
    expect(a).toBe(b);
  });

  it("diverge ao mudar grupo", () => {
    const a = computeIngestionDedupeHash(baseParts(), WINDOW_MS);
    const b = computeIngestionDedupeHash(
      { ...baseParts(), groupExternalId: "outro-group" },
      WINDOW_MS
    );
    expect(a).not.toBe(b);
  });

  it("diverge ao mudar o remetente", () => {
    const a = computeIngestionDedupeHash(baseParts(), WINDOW_MS);
    const b = computeIngestionDedupeHash(
      { ...baseParts(), senderPhone: "5511888888888" },
      WINDOW_MS
    );
    expect(a).not.toBe(b);
  });

  it("diverge ao mudar conteúdo", () => {
    const a = computeIngestionDedupeHash(baseParts(), WINDOW_MS);
    const b = computeIngestionDedupeHash({ ...baseParts(), content: "outra" }, WINDOW_MS);
    expect(a).not.toBe(b);
  });

  it("diverge quando sentAt cruza o bucket de janela", () => {
    const a = computeIngestionDedupeHash(baseParts(), WINDOW_MS);
    const b = computeIngestionDedupeHash(
      { ...baseParts(), sentAt: new Date("2026-04-16T12:02:00.000Z") },
      WINDOW_MS
    );
    expect(a).not.toBe(b);
  });

  it("usa senderExternalId quando senderPhone é null", () => {
    const withPhone = computeIngestionDedupeHash({ ...baseParts(), senderPhone: null }, WINDOW_MS);
    const withExternal = computeIngestionDedupeHash(
      { ...baseParts(), senderPhone: null, senderExternalId: "outro-lid" },
      WINDOW_MS
    );
    expect(withPhone).not.toBe(withExternal);
  });

  it("usa 'unknown' quando sender é todo nulo", () => {
    const a = computeIngestionDedupeHash(
      { ...baseParts(), senderPhone: null, senderExternalId: null },
      WINDOW_MS
    );
    const b = computeIngestionDedupeHash(
      { ...baseParts(), senderPhone: null, senderExternalId: null },
      WINDOW_MS
    );
    expect(a).toBe(b);
  });
});

describe("computeContentHash", () => {
  it("gera o mesmo hash para o mesmo conteúdo", () => {
    expect(computeContentHash("hello world")).toBe(computeContentHash("hello world"));
  });

  it("gera hashes diferentes para conteúdos diferentes", () => {
    expect(computeContentHash("a")).not.toBe(computeContentHash("b"));
  });

  it("não depende de grupo nem remetente (reuso cross-grupo)", () => {
    const texto = "tenho vaga em grupo de plantão";
    expect(computeContentHash(texto)).toBe(computeContentHash(texto));
  });
});
