import { describe, expect, it } from "bun:test";
import { ContentFilterService } from "./content-filter-service.ts";

const svc = new ContentFilterService();

function makeInput(overrides: {
  senderPhone?: string | null;
  senderName?: string | null;
  normalizedText?: string | null;
  caption?: string | null;
}) {
  return {
    senderPhone: overrides.senderPhone ?? "+5511999990001",
    senderName: overrides.senderName ?? "Usuário Normal",
    normalizedText: overrides.normalizedText ?? null,
    caption: overrides.caption ?? null,
  };
}

describe("ContentFilterService.detect", () => {
  it("retorna null quando nenhuma regra bate", () => {
    expect(svc.detect(makeInput({}))).toBeNull();
  });

  it("detecta DDI suspeito (27 = África do Sul) em número não-BR", () => {
    const hit = svc.detect(makeInput({ senderPhone: "+27821234567" }));
    expect(hit).toEqual({ motivo: "ddi", match: "27" });
  });

  it("detecta DDI suspeito (57 = Colômbia)", () => {
    const hit = svc.detect(makeInput({ senderPhone: "+573001234567" }));
    expect(hit).toEqual({ motivo: "ddi", match: "57" });
  });

  it("não detecta DDI para número BR (55)", () => {
    expect(svc.detect(makeInput({ senderPhone: "+5511999990001" }))).toBeNull();
  });

  it("detecta padrão de bot: name = MI + últimos 6 dígitos", () => {
    // phone digits: 5511999990001 → últimos 6 = 990001
    const hit = svc.detect(makeInput({ senderPhone: "+5511999990001", senderName: "MI990001" }));
    expect(hit).toEqual({ motivo: "nome_bot", match: "MI990001" });
  });

  it("não detecta bot quando sufixo não coincide", () => {
    expect(
      svc.detect(makeInput({ senderPhone: "+5511999990001", senderName: "MI123456" }))
    ).toBeNull();
  });

  it("detecta nome suspeito (substring)", () => {
    const hit = svc.detect(makeInput({ senderName: "Olá sou da Med Open aqui" }));
    expect(hit).toEqual({ motivo: "nome", match: "Med Open" });
  });

  it("detecta conteúdo suspeito em normalizedText", () => {
    const hit = svc.detect(makeInput({ normalizedText: "compre agora Medcurso 2025" }));
    expect(hit).toEqual({ motivo: "content", match: "Medcurso" });
  });

  it("detecta conteúdo suspeito em caption", () => {
    const hit = svc.detect(makeInput({ caption: "acesse hotmart.com/produto" }));
    expect(hit).toEqual({ motivo: "content", match: "hotmart.com" });
  });

  it("caption é checado mesmo quando normalizedText é null", () => {
    const hit = svc.detect(makeInput({ normalizedText: null, caption: "Medgrupo pra você" }));
    expect(hit).toEqual({ motivo: "content", match: "Medgrupo" });
  });

  it("tolera todos os inputs null sem lançar erro", () => {
    expect(
      svc.detect({ senderPhone: null, senderName: null, normalizedText: null, caption: null })
    ).toBeNull();
  });

  it("DDI não dispara para número BR mesmo com prefixo parecido", () => {
    // Número BR começa com 55, não deve disparar
    expect(svc.detect(makeInput({ senderPhone: "+5527991234567" }))).toBeNull();
  });
});
