// Carregado via `bun --preload` para garantir que Sentry.init roda antes
// de qualquer outro módulo (auto-instrumentation depende disso).
// Nota: @sentry/bun não suporta profilesSampleRate — só @sentry/node tem.
import * as Sentry from "@sentry/bun";
import { env } from "../config/env.ts";
import { logger } from "./logger.ts";

const SENSITIVE_QUERY_KEYS = ["secret", "token", "api_key", "apikey"];

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of SENSITIVE_QUERY_KEYS) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

if (env.SENTRY_DSN) {
  // SERVICE_NAME é setada pelos scripts de start (package.json) — mesma var usada pelo logger.
  const serviceName = process.env.SERVICE_NAME;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    serverName: serviceName,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    initialScope: serviceName ? { tags: { service: serviceName } } : undefined,
    beforeSend(event) {
      if (event.request?.url) event.request.url = sanitizeUrl(event.request.url);
      if (event.breadcrumbs) {
        for (const b of event.breadcrumbs) {
          if (b.data?.url && typeof b.data.url === "string") {
            b.data.url = sanitizeUrl(b.data.url);
          }
        }
      }
      return event;
    },
  });

  logger.info({ environment: env.SENTRY_ENVIRONMENT, service: serviceName }, "Sentry init ok");
} else {
  logger.warn("SENTRY_DSN ausente — captura de erros desativada");
}
