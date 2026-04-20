import { describe, expect, it } from "bun:test";
import { toE164, toZapiDigits } from "./phone.ts";

describe("toE164", () => {
  it("retorna null para null/undefined/vazio", () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("   ")).toBeNull();
  });

  it("normaliza BR sem + para E.164", () => {
    expect(toE164("5547997490248")).toBe("+5547997490248");
  });

  it("aceita entrada já em E.164", () => {
    expect(toE164("+5547997490248")).toBe("+5547997490248");
  });

  it("remove máscaras e espaços", () => {
    expect(toE164("+55 (47) 99749-0248")).toBe("+5547997490248");
    expect(toE164("55 47 99749-0248")).toBe("+5547997490248");
  });

  it("idempotente em E.164", () => {
    const once = toE164("+5547997490248");
    expect(toE164(once)).toBe("+5547997490248");
  });

  it("suporta outros países", () => {
    // US
    expect(toE164("+14155552671")).toBe("+14155552671");
    expect(toE164("14155552671")).toBe("+14155552671");
    // PT
    expect(toE164("+351912345678")).toBe("+351912345678");
  });

  it("retorna null para input inválido", () => {
    expect(toE164("abc")).toBeNull();
    expect(toE164("12")).toBeNull();
    expect(toE164("99999999999999999999")).toBeNull();
  });

  it("rejeita formato LID (contém @)", () => {
    expect(toE164("1234567890@lid")).toBeNull();
  });
});

describe("toZapiDigits", () => {
  it("remove + inicial", () => {
    expect(toZapiDigits("+5547997490248")).toBe("5547997490248");
  });

  it("null-safe", () => {
    expect(toZapiDigits(null)).toBeNull();
  });

  it("retorna como veio se não tem +", () => {
    expect(toZapiDigits("5547997490248")).toBe("5547997490248");
  });
});
