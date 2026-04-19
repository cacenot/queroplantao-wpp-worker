import { Elysia } from "elysia";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super("Invalid JSON");
    this.name = "InvalidJsonError";
  }
}

async function readBodyCapped(
  body: ReadableStream<Uint8Array>,
  max: number
): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          // noop: reader já fechado
        }
        return null;
      }

      chunks.push(value);
    }
  } catch {
    // Falha de stream vira InvalidJsonError no chamador (body vazio).
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Plugin Elysia que valida e parseia JSON com limite de tamanho.
 * Monta `ctx.body` com o JSON parseado; excesso → 413, JSON inválido → 400.
 * Cada instância é deduplicada por `max` via `name`.
 */
export function bodyLimitPlugin({ max }: { max: number }) {
  return new Elysia({ name: `body-limit:${max}` })
    .onParse({ as: "scoped" }, async ({ request, contentType }) => {
      if (!contentType?.includes("application/json")) return;

      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > max) {
        throw new PayloadTooLargeError();
      }

      if (!request.body) {
        throw new InvalidJsonError();
      }

      const bytes = await readBodyCapped(request.body, max);
      if (bytes === null) {
        throw new PayloadTooLargeError();
      }
      if (bytes.byteLength === 0) {
        throw new InvalidJsonError();
      }

      try {
        return JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new InvalidJsonError();
      }
    })
    .onError({ as: "scoped" }, ({ error, set }) => {
      // Elysia embrulha o throw do onParse em `ParseError`; a original vai em `cause`.
      const original = (error as { cause?: unknown }).cause ?? error;
      if (original instanceof PayloadTooLargeError) {
        set.status = 413;
        return { error: "Payload too large" };
      }
      if (original instanceof InvalidJsonError) {
        set.status = 400;
        return { error: "Invalid JSON" };
      }
    });
}
