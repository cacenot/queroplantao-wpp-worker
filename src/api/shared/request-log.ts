import { Elysia } from "elysia";
import { logger } from "../../lib/logger.ts";

const EXCLUDED_PATHS = new Set(["/health", "/docs", "/docs/json"]);

function isExcluded(pathname: string): boolean {
  if (EXCLUDED_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/docs/")) return true;
  return false;
}

export const requestLogPlugin = new Elysia({ name: "request-log" })
  .derive({ as: "global" }, () => ({ __requestStart: performance.now() }))
  .onAfterResponse({ as: "global" }, ({ request, set, __requestStart }) => {
    const url = new URL(request.url);
    if (isExcluded(url.pathname)) return;
    const start = __requestStart ?? performance.now();
    const latencyMs = Math.round(performance.now() - start);
    const status = typeof set.status === "number" ? set.status : 200;
    logger.info({ method: request.method, path: url.pathname, status, latencyMs }, "HTTP");
  });
