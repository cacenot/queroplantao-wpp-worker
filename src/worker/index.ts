import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { initSentry } from "../lib/sentry.ts";
import { buildDeps } from "./deps.ts";
import { createJobHandler } from "./handler.ts";

initSentry();

async function main() {
  logger.info("Iniciando wpp-worker");

  const {
    redis,
    sql,
    rabbit,
    topology,
    retryPublisher,
    whatsappGatewayRegistry,
    taskService,
    moderationsRepo,
    groupMessagesRepo,
    moderate,
  } = await buildDeps();

  // --- Health flag: reflete se o rabbit está conectado e sem erros recentes ---
  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  // --- Consumer AMQP: processa jobs da fila ---
  const handleMessage = createJobHandler({
    whatsappGatewayRegistry,
    moderate,
    taskService,
    moderationsRepo,
    groupMessagesRepo,
    publisher: retryPublisher,
    topology,
    onSuccess: () => {
      healthy = true;
    },
  });

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
    healthy = false;
  });

  logger.info({ queue: env.AMQP_QUEUE }, "Worker ativo — aguardando jobs");

  // --- Servidor HTTP de health check ---
  const healthServer = Bun.serve({
    port: env.WORKER_HEALTH_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(
          { status: healthy ? "ok" : "degraded" },
          { status: healthy ? 200 : 503 }
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });

  logger.info({ port: healthServer.port }, "Health check server iniciado");

  // --- Graceful shutdown: fecha todas as conexões em ordem ---
  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando worker");
    try {
      healthServer.stop();
      await consumer.close();
      await retryPublisher.close();
      await rabbit.close();
      await sql.end();
      redis.disconnect();
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
