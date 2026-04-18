import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { buildDeps } from "./deps.ts";
import { startHttpServer } from "./server.ts";

async function main() {
  logger.info("Iniciando wpp-api");

  const { sql, redis, rabbit, publisher, taskService, instanceService, groupMessagesService } =
    await buildDeps();

  // --- Health flag: reflete se o rabbit está conectado e sem erros recentes ---
  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  // --- Servidor HTTP ---
  const httpServer = startHttpServer({
    taskService,
    instanceService,
    groupMessagesService,

    webhookSecret: env.ZAPI_RECEIVED_WEBHOOK_SECRET,
    webhookEnabled: env.ZAPI_RECEIVED_WEBHOOK_ENABLED,
    isHealthy: () => healthy,
  });

  logger.info({ port: env.HTTP_PORT }, "wpp-api pronta");

  // --- Graceful shutdown: fecha todas as conexões em ordem ---
  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando api");
    try {
      await httpServer.stop();
      await publisher.close();
      await rabbit.close();
      await redis.quit();
      await sql.end({ timeout: 5 });
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
