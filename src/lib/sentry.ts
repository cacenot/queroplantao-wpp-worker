import * as Sentry from "@sentry/node";
import { env } from "../config/env.ts";

let initialized = false;
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

export function initSentry(): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
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

  initialized = true;
}

export { Sentry };
