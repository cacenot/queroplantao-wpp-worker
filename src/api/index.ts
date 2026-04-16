import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { MessagingProviderInstanceRepository } from "../db/repositories/messaging-provider-instance-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { MessagingProviderInstanceService } from "../services/messaging-provider-instance/index.ts";
import { TaskService } from "../services/task/index.ts";
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

  const sql = createDbConnection();
  const db = createDrizzleDb(sql);

  const taskService = new TaskService({
    repo: new TaskRepository(db),
    publisher,
    queueName: env.AMQP_QUEUE,
  });

  const instanceService = new MessagingProviderInstanceService(
    new MessagingProviderInstanceRepository(db)
  );

  const httpServer = startHttpServer({
    taskService,
    instanceService,
    isHealthy: () => healthy,
  });

  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando api");
    try {
      await httpServer.stop();
      await publisher.close();
      await rabbit.close();
      await sql.end({ timeout: 5 });
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
