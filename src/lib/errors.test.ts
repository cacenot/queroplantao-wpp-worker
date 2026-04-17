import { describe, expect, it } from "bun:test";
import { NonRetryableError } from "./errors.ts";

describe("NonRetryableError", () => {
  it("preserva message e name", () => {
    const err = new NonRetryableError("permanent failure");
    expect(err.message).toBe("permanent failure");
    expect(err.name).toBe("NonRetryableError");
  });

  it("preserva cause quando passado", () => {
    const root = new Error("root");
    const err = new NonRetryableError("wrap", root);
    expect(err.cause).toBe(root);
  });

  it("é instanceof Error e NonRetryableError", () => {
    const err = new NonRetryableError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NonRetryableError);
  });
});
