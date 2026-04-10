import { env } from "./config/env.ts";
import { startHttpServer } from "./http/server.ts";
import { createJobHandler } from "./jobs/handler.ts";
import { createAmqpConnection } from "./lib/amqp.ts";
import { logger } from "./lib/logger.ts";
import { ZApiGateway } from "./zapi/gateway.ts";

async function main() {
  logger.info("Iniciando wpp-worker");

  const gateway = new ZApiGateway({
    instances: env.ZAPI_INSTANCES,
    concurrencyPerInstance: env.ZAPI_CONCURRENCY_PER_INSTANCE,
    delayMinMs: env.ZAPI_DELAY_MIN_MS,
    delayMaxMs: env.ZAPI_DELAY_MAX_MS,
  });

  const rabbit = createAmqpConnection();

  const handleMessage = createJobHandler(gateway);

  const consumer = rabbit.createConsumer(
    {
      queue: env.AMQP_QUEUE,
      queueOptions: { durable: true },
      qos: { prefetchCount: env.AMQP_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP");
  });

  logger.info({ queue: env.AMQP_QUEUE }, "Worker ativo — aguardando jobs");

  const publisher = rabbit.createPublisher({
    confirm: true,
    maxAttempts: 2,
  });

  const httpServer = startHttpServer(publisher);

  // Graceful shutdown: fecha publisher, consumer e connection antes de encerrar o processo
  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando worker");
    try {
      httpServer.stop();
      await publisher.close();
      await consumer.close();
      await rabbit.close();
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar o worker");
  process.exit(1);
});
