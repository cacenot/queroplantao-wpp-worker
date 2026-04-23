import { env } from "../../config/env.ts";
import { registerCrashHandlers } from "../../lib/crash-handlers.ts";
import { logger } from "../../lib/logger.ts";
import { initSentry } from "../../lib/sentry.ts";
import { closeSharedDeps } from "../shared/build-shared-deps.ts";
import { createJobHandler } from "../shared/handler-base.ts";
import { buildModerationWorkerDeps } from "./deps.ts";
import { createModerationExecuteJob } from "./handler.ts";

initSentry();

async function main() {
  logger.info("Iniciando moderation-worker");
  registerCrashHandlers(logger);

  const deps = await buildModerationWorkerDeps();

  // --- Health flag: reflete se o rabbit está conectado e sem erros recentes ---
  let healthy = false;
  deps.rabbit.on("connection", () => {
    healthy = true;
  });
  deps.rabbit.on("error", () => {
    healthy = false;
  });

  // --- Consumer AMQP: processa jobs de moderação ---
  const executeJob = createModerationExecuteJob({
    moderationsRepo: deps.moderationsRepo,
    groupMessagesRepo: deps.groupMessagesRepo,
    moderate: deps.moderate,
    enforcement: deps.enforcement,
  });

  const handleMessage = createJobHandler({
    executeJob,
    taskService: deps.taskService,
    publisher: deps.publisher,
    maxRetries: deps.topologies.moderation.maxRetries,
    onSuccess: () => {
      healthy = true;
    },
  });

  // Sem queueOptions: a fila já foi declarada em buildSharedDeps.
  const consumer = deps.rabbit.createConsumer(
    {
      queue: deps.topologies.moderation.mainQueue,
      qos: { prefetchCount: env.AMQP_MODERATION_PREFETCH },
    },
    handleMessage
  );

  consumer.on("error", (err) => {
    logger.error({ err }, "Erro no consumer AMQP (moderation-worker)");
    healthy = false;
  });

  logger.info(
    { queue: deps.topologies.moderation.mainQueue, prefetch: env.AMQP_MODERATION_PREFETCH },
    "moderation-worker ativo — aguardando jobs"
  );

  // --- Servidor HTTP de health check ---
  const healthServer = Bun.serve({
    port: env.WORKER_MODERATION_HEALTH_PORT,
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
    logger.info({ signal }, "Sinal recebido — encerrando moderation-worker");
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
  logger.fatal({ err }, "Erro fatal ao inicializar moderation-worker");
  process.exit(1);
});
