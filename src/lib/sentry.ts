import * as Sentry from "@sentry/node";
import { env } from "../config/env.ts";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
  });

  initialized = true;
}

export { Sentry };
