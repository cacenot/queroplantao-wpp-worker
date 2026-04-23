import { env } from "../../config/env.ts";
import { registerCrashHandlers } from "../../lib/crash-handlers.ts";
import { logger } from "../../lib/logger.ts";
import { initSentry } from "../../lib/sentry.ts";
import { closeSharedDeps } from "../shared/build-shared-deps.ts";
import { createJobHandler } from "../shared/handler-base.ts";
import { buildZapiWorkerDeps } from "./deps.ts";
import { createZapiExecuteJob } from "./handler.ts";

initSentry();

async function main() {
  logger.info("Iniciando whatsapp-zapi-worker");
  registerCrashHandlers(logger);

  const deps = await buildZapiWorkerDeps();

  // --- Health flag: reflete se o rabbit está conectado e sem erros recentes ---
  let healthy = false;
  deps.rabbit.on("connection", () => {
    healthy = true;
  });
  deps.rabbit.on("error", () => {
    healthy = false;
  });

  // --- Consumer AMQP: processa jobs da fila ---
  const executeJob = createZapiExecuteJob({
    whatsappGatewayRegistry: deps.whatsappGatewayRegistry,
    groupMessagesRepo: deps.groupMessagesRepo,
  });

  const handleMessage = createJobHandler({
    executeJob,
    taskService: deps.taskService,
    publisher: deps.publisher,
    maxRetries: deps.topologies.zapi.maxRetries,
    onSuccess: () => {
      healthy = true;
    },
  });

  // Sem queueOptions: a fila já foi declarada em buildSharedDeps com a priority correta.
  // Manter o declare em um único lugar evita PRECONDITION_FAILED se os args divergirem.
  const consumer = deps.rabbit.createConsumer(
    {
      queue: deps.topologies.zapi.mainQueue,
      qos: { prefetchCount: env.AMQP_ZAPI_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP (zapi-worker)");
    healthy = false;
  });

  logger.info(
    { queue: deps.topologies.zapi.mainQueue, prefetch: env.AMQP_ZAPI_PREFETCH },
    "zapi-worker ativo — aguardando jobs"
  );

  // --- Servidor HTTP de health check ---
  const healthServer = Bun.serve({
    port: env.WORKER_ZAPI_HEALTH_PORT,
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
    logger.info({ signal }, "Sinal recebido — encerrando zapi-worker");
    try {
      healthServer.stop();
      await consumer.close();
      await closeSharedDeps(deps);
    } catch (err) {
      logger.warn({ err }, "Erro ao fechar conexões durante shutdown");
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Erro fatal ao inicializar zapi-worker");
  process.exit(1);
});
