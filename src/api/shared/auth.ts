import { Elysia } from "elysia";
import { env } from "../../config/env.ts";
import { timingSafeEqual } from "./timing-safe.ts";

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
