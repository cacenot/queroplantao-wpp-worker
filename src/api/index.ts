import * as Sentry from "@sentry/bun";
import { env } from "../config/env.ts";
import { registerCrashHandlers } from "../lib/crash-handlers.ts";
import { computeHealth } from "../lib/health.ts";
import { logger } from "../lib/logger.ts";
import { buildDeps } from "./deps.ts";
import { startHttpServer } from "./server.ts";

async function main() {
  logger.info("Iniciando messaging-api");
  registerCrashHandlers(logger);

  const deps = await buildDeps();

  const httpServer = startHttpServer({
    deps,
    webhookConfig: {
      secret: env.ZAPI_RECEIVED_WEBHOOK_SECRET,
      enabled: env.ZAPI_RECEIVED_WEBHOOK_ENABLED,
    },
    getHealth: () => computeHealth(deps),
  });

  logger.info({ port: env.HTTP_PORT }, "messaging-api pronta");

  // --- Graceful shutdown: fecha todas as conexões em ordem ---
  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando api");
    try {
      await httpServer.stop();
      await deps.publisher.close();
      await deps.rabbit.close();
      await deps.redis.quit();
      await deps.sql.end({ timeout: 5 });
      await Sentry.close(2000);
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar a api");
  process.exit(1);
});
