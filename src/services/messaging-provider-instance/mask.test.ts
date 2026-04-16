import { describe, expect, it } from "bun:test";
import { maskToken } from "./mask.ts";

describe("maskToken", () => {
  it("retorna **** para tokens curtos (<=8)", () => {
    expect(maskToken("")).toBe("****");
    expect(maskToken("1234")).toBe("****");
    expect(maskToken("12345678")).toBe("****");
  });

  it("mostra 4 primeiros + ... + 4 últimos para tokens longos", () => {
    expect(maskToken("abcdefghij")).toBe("abcd...ghij");
    expect(maskToken("supersecret1234")).toBe("supe...1234");
  });
});
