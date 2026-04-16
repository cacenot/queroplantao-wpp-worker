import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";
import type { Publisher } from "rabbitmq-client";
import { env } from "../config/env.ts";
import type { Db } from "../db/client.ts";
import { MessagingProviderInstanceRepository } from "../db/repositories/messaging-provider-instance-repository.ts";
import { logger } from "../lib/logger.ts";
import { MessagingProviderInstanceService } from "../services/messaging-provider-instance/index.ts";
import { providerInstancesRoutes } from "./routes/provider-instances.ts";
import { tasksRoutes } from "./routes/tasks.ts";

export interface HttpServerHandle {
  stop(): Promise<void> | void;
  port: number;
}

export function startHttpServer(
  publisher: Publisher,
  isHealthy: () => boolean,
  db?: Db
): HttpServerHandle {
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
          ],
        },
      })
    )
    .get("/health", ({ set }) => {
      const ok = isHealthy();
      if (!ok) set.status = 503;
      return { status: ok ? "ok" : "degraded" };
    })
    .use(tasksRoutes(publisher));

  if (db) {
    const instanceService = new MessagingProviderInstanceService(
      new MessagingProviderInstanceRepository(db)
    );
    app.use(providerInstancesRoutes(instanceService));
  }

  app.listen(env.HTTP_PORT);

  const port = app.server?.port ?? 0;
  logger.info({ port }, "HTTP server iniciado");

  return {
    stop: async () => {
      await app.stop();
    },
    port,
  };
}
