import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { env } from "../../config/env.ts";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.byteLength !== bufB.byteLength) {
    cryptoTimingSafeEqual(bufA, bufA);
    return false;
  }

  return cryptoTimingSafeEqual(bufA, bufB);
}

export const authPlugin = new Elysia({ name: "auth" }).onBeforeHandle(
  { as: "scoped" },
  ({ headers, set }) => {
    const provided = headers["x-api-key"] ?? "";
    if (!provided || !timingSafeEqual(provided, env.HTTP_API_KEY)) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  }
);
