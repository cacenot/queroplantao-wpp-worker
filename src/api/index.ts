import { env } from "../config/env.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { startHttpServer } from "./server.ts";

async function main() {
  logger.info("Iniciando wpp-api");

  const rabbit = createAmqpConnection();

  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  const publisher = rabbit.createPublisher({
    confirm: true,
    maxAttempts: 2,
  });

  const httpServer = startHttpServer(publisher, () => healthy);

  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando api");
    try {
      httpServer.stop();
      await publisher.close();
      await rabbit.close();
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info({ port: env.HTTP_PORT }, "wpp-api pronta");
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar a api");
  process.exit(1);
});
