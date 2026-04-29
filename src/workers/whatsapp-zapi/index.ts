import * as Sentry from "@sentry/bun";
import { env } from "../../config/env.ts";
import { registerCrashHandlers } from "../../lib/crash-handlers.ts";
import { computeHealth } from "../../lib/health.ts";
import { logger } from "../../lib/logger.ts";
import { closeSharedDeps } from "../shared/build-shared-deps.ts";
import { createJobHandler } from "../shared/handler-base.ts";
import { buildZapiWorkerDeps } from "./deps.ts";
import { createZapiExecuteJob, createZapiTerminalFailureHandler } from "./handler.ts";

async function main() {
  logger.info("Iniciando whatsapp-zapi-worker");
  registerCrashHandlers(logger);

  const deps = await buildZapiWorkerDeps();

  const executeJob = createZapiExecuteJob({
    whatsappGatewayRegistry: deps.whatsappGatewayRegistry,
    groupMessagesRepo: deps.groupMessagesRepo,
    outboundMessagesRepo: deps.outboundMessagesRepo,
  });

  const handleMessage = createJobHandler({
    executeJob,
    taskService: deps.taskService,
    publisher: deps.publisher,
    maxRetries: deps.topologies.zapi.maxRetries,
    onTerminalFailure: createZapiTerminalFailureHandler(deps.outboundMessagesRepo),
  });

  // `queueOptions: { passive: true }` porque o Consumer do rabbitmq-client sempre
  // chama queueDeclare no setup (incluindo cada reconexão). Sem passive, ele iria
  // com defaults (durable:false, sem arguments) e conflitaria com a fila que
  // declareJobTopologies criou com durable:true + x-max-priority. Passive só
  // verifica existência, sem tocar nos args — declaração fica só em topology.ts.
  const consumer = deps.rabbit.createConsumer(
    {
      queue: deps.topologies.zapi.mainQueue,
      queueOptions: { passive: true },
      qos: { prefetchCount: env.AMQP_ZAPI_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP (zapi-worker)");
  });

  logger.info(
    { queue: deps.topologies.zapi.mainQueue, prefetch: env.AMQP_ZAPI_PREFETCH },
    "zapi-worker ativo — aguardando jobs"
  );

  const healthServer = Bun.serve({
    port: env.WORKER_ZAPI_HEALTH_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        const health = computeHealth(deps);
        return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
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
  logger.fatal({ err }, "Erro fatal ao inicializar zapi-worker");
  process.exit(1);
});
