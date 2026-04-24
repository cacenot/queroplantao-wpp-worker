import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import { env } from "../config/env.ts";
import type { HealthReport } from "../lib/health.ts";
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
  getHealth: () => HealthReport;
  port?: number;
}

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
  const { deps, webhookConfig, getHealth, port: portOverride } = options;

  const app = new Elysia()
    .use(
      swagger({
        path: "/docs",
        documentation: {
          info: {
            title: "Messaging API",
            version: "0.1.0",
            description:
              "API interna do messaging-api. Gerencia ingestão de tasks e registry de provider instances.",
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
      const health = getHealth();
      if (health.status !== "ok") set.status = 503;
      return health;
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
