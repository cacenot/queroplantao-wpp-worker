import { env } from "./config/env.ts";
import { createJobHandler } from "./jobs/handler.ts";
import { connectAmqp } from "./lib/amqp.ts";
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

  const { connection, channel } = await connectAmqp();

  const handleMessage = createJobHandler(channel, gateway);

  // noAck: false — confirmação manual; garante que nenhum job seja perdido silenciosamente
  await channel.consume(env.AMQP_QUEUE, handleMessage, { noAck: false });

  logger.info({ queue: env.AMQP_QUEUE }, "Worker ativo — aguardando jobs");

  // Graceful shutdown: fecha channel e connection antes de encerrar o processo
  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando worker");
    try {
      await channel.close();
      await connection.close();
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexão AMQP durante shutdown");
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
