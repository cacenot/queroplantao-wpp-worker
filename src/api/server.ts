import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { composeApp, type WebhookConfig } from "./app.ts";
import type { ApiDeps } from "./deps.ts";

export interface HttpServerHandle {
  stop(): Promise<void> | void;
  port: number;
}

export interface HttpServerOptions {
  deps: ApiDeps;
  webhookConfig: WebhookConfig;
  isHealthy: () => boolean;
  port?: number;
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const { deps, webhookConfig, isHealthy, port: portOverride } = options;

  const app = new Elysia()
    .use(
      swagger({
        path: "/docs",
        documentation: {
          info: {
            title: "WPP Worker API",
            version: "0.1.0",
            description:
              "API interna do wpp-worker. Gerencia ingestão de tasks e registry de provider instances.",
          },
          tags: [
            { name: "tasks", description: "Publicação de jobs no AMQP" },
            { name: "providers", description: "Provider instances (CRUD)" },
            { name: "webhooks", description: "Webhooks de providers externos" },
          ],
        },
      })
    )
    .get("/health", ({ set }) => {
      const ok = isHealthy();
      if (!ok) set.status = 503;
      return { status: ok ? "ok" : "degraded" };
    })
    .use(composeApp(deps, webhookConfig));

  app.listen(portOverride ?? env.HTTP_PORT);

  const port = app.server?.port ?? 0;
  logger.info({ port }, "HTTP server iniciado");

  return {
    stop: async () => {
      await app.stop();
    },
    port,
  };
}
