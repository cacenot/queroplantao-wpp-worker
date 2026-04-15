import type { Publisher } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { handleTasks } from "./routes/tasks.ts";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export function startHttpServer(
  publisher: Publisher,
  isHealthy: () => boolean
): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: env.HTTP_PORT,

    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        const ok = isHealthy();
        return json({ status: ok ? "ok" : "degraded" }, ok ? 200 : 503);
      }

      if (url.pathname === "/tasks" && req.method === "POST") {
        try {
          return await handleTasks(req, publisher);
        } catch (err) {
          logger.error({ err }, "Erro inesperado ao processar POST /tasks");
          return json({ error: "Internal server error" }, 500);
        }
      }

      return json({ error: "Not found" }, 404);
    },
  });

  logger.info({ port: server.port }, "HTTP server iniciado");

  return server;
}
