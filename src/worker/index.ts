import { createModel } from "../ai/model.ts";
import { classifyMessage } from "../ai/moderator.ts";
import { env } from "../config/env.ts";
import { createDbConnection } from "../db/client.ts";
import { createAmqpConnection } from "../lib/amqp.ts";
import { logger } from "../lib/logger.ts";
import { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { ProviderGateway } from "../messaging/gateway.ts";
import { createZApiProviders } from "../messaging/whatsapp/zapi/provider.ts";
import { createJobHandler } from "./handler.ts";

async function main() {
  logger.info("Iniciando wpp-worker");

  const redis = createRedisConnection(env.REDIS_URL);

  const whatsappGateway = new ProviderGateway({
    redis,
    providers: createZApiProviders(env.ZAPI_INSTANCES),
    delayMinMs: env.ZAPI_DELAY_MIN_MS,
    delayMaxMs: env.ZAPI_DELAY_MAX_MS,
    redisKey: "messaging:whatsapp",
  });

  await whatsappGateway.registerProviders();

  const rabbit = createAmqpConnection();
  const sql = createDbConnection();

  const analyzeMessageModel = createModel(env.AI_MODEL_ANALYZE_MESSAGE);
  const adminApi = new QpAdminApiClient(env.QP_ADMIN_API_URL, env.QP_ADMIN_API_TOKEN);

  let healthy = false;

  rabbit.on("connection", () => {
    healthy = true;
  });
  rabbit.on("error", () => {
    healthy = false;
  });

  const handleMessage = createJobHandler({
    whatsappGateway,
    classifyMessage: (text) => classifyMessage(text, analyzeMessageModel),
    adminApi,
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

  async function shutdown(signal: string) {
    logger.info({ signal }, "Sinal recebido — encerrando worker");
    try {
      healthServer.stop();
      await consumer.close();
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
