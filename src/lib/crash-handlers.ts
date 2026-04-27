import * as Sentry from "@sentry/bun";
import type { Logger } from "pino";

export function registerCrashHandlers(logger: Logger): void {
  process.on("uncaughtException", async (err) => {
    logger.fatal({ err }, "uncaughtException — derrubando processo");
    Sentry.captureException(err, { tags: { handler: "uncaughtException" } });
    await Sentry.close(2000).catch(() => undefined);
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    logger.fatal({ err: reason }, "unhandledRejection — derrubando processo");
    Sentry.captureException(reason, { tags: { handler: "unhandledRejection" } });
    await Sentry.close(2000).catch(() => undefined);
    process.exit(1);
  });
}
