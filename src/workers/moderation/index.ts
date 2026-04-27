import * as Sentry from "@sentry/bun";
import { env } from "../../config/env.ts";
import { registerCrashHandlers } from "../../lib/crash-handlers.ts";
import { computeHealth } from "../../lib/health.ts";
import { logger } from "../../lib/logger.ts";
import { closeSharedDeps } from "../shared/build-shared-deps.ts";
import { createJobHandler } from "../shared/handler-base.ts";
import { buildModerationWorkerDeps } from "./deps.ts";
import { createModerationExecuteJob } from "./handler.ts";

async function main() {
  logger.info("Iniciando moderation-worker");
  registerCrashHandlers(logger);

  const deps = await buildModerationWorkerDeps();

  const executeJob = createModerationExecuteJob({
    moderationsRepo: deps.moderationsRepo,
    groupMessagesRepo: deps.groupMessagesRepo,
    moderate: deps.moderate,
    enforcement: deps.enforcement,
    participantsService: deps.participantsService,
  });

  const handleMessage = createJobHandler({
    executeJob,
    taskService: deps.taskService,
    publisher: deps.publisher,
    maxRetries: deps.topologies.moderation.maxRetries,
  });

  // `queueOptions: { passive: true }` porque o Consumer do rabbitmq-client sempre
  // chama queueDeclare no setup (incluindo cada reconexão). Sem passive, ele iria
  // com defaults (durable:false) e conflitaria com a fila que declareJobTopologies
  // criou com durable:true. Passive só verifica existência — declaração fica só em
  // topology.ts.
  const consumer = deps.rabbit.createConsumer(
    {
      queue: deps.topologies.moderation.mainQueue,
      queueOptions: { passive: true },
      qos: { prefetchCount: env.AMQP_MODERATION_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP (moderation-worker)");
  });

  logger.info(
    { queue: deps.topologies.moderation.mainQueue, prefetch: env.AMQP_MODERATION_PREFETCH },
    "moderation-worker ativo — aguardando jobs"
  );

  const healthServer = Bun.serve({
    port: env.WORKER_MODERATION_HEALTH_PORT,
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
    logger.info({ signal }, "Sinal recebido — encerrando moderation-worker");
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
  logger.fatal({ err }, "Erro fatal ao inicializar moderation-worker");
  process.exit(1);
});
