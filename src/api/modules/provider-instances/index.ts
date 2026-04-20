import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import {
  ConflictError,
  type MessagingProviderInstanceService,
  RESTART_WARNING,
  ZApiRefreshError,
} from "../../../services/messaging-provider-instance/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import { providerInstancesModel } from "./model.ts";

export interface ProviderInstancesModuleDeps {
  instanceService: MessagingProviderInstanceService;
}

export function providerInstancesModule(deps: ProviderInstancesModuleDeps) {
  const { instanceService } = deps;

  return new Elysia({
    name: "provider-instances-module",
    prefix: "/providers/instances",
    tags: ["providers"],
  })
    .use(authPlugin)
    .use(providerInstancesModel)
    .post(
      "/",
      async ({ body, set }) => {
        try {
          const view = await instanceService.createZApiInstance({
            ...body,
            redisKey: body.redisKey ?? "qp:whatsapp",
          });
          logger.info(
            { providerInstanceId: view.id, zapiInstanceId: view.zapi?.zapiInstanceId },
            "Provider instance criada via HTTP"
          );
          set.status = 201;
          return { data: view, warning: RESTART_WARNING };
        } catch (err) {
          if (err instanceof ConflictError) {
            set.status = 409;
            return { error: err.message };
          }
          if (err instanceof ZApiRefreshError) {
            set.status = 502;
            return { error: `Falha ao sincronizar com a Z-API: ${err.message}` };
          }
          throw err;
        }
      },
      {
        body: "providerInstances.create.body",
        response: {
          201: "providerInstances.create.response",
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
        detail: { summary: "Cria uma instância Z-API no provider registry" },
      }
    )
    .get(
      "/",
      async ({ query }) => {
        const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
        const offset = Math.max(query.offset ?? 0, 0);

        return instanceService.list(
          {
            protocol: query.protocol,
            providerKind: query.providerKind,
            isEnabled: query.isEnabled,
          },
          { limit, offset }
        );
      },
      {
        query: "providerInstances.list.query",
        response: {
          200: "providerInstances.list.response",
          401: errorResponseSchema,
        },
        detail: { summary: "Lista provider instances com paginação e filtros" },
      }
    )
    .get(
      "/:id",
      async ({ params, set }) => {
        const view = await instanceService.get(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        return { data: view };
      },
      {
        params: "providerInstances.id.params",
        response: {
          200: "providerInstances.get.response",
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Retorna uma provider instance pelo id" },
      }
    )
    .patch(
      "/:id",
      async ({ params, body, set }) => {
        try {
          const view = await instanceService.updateZApiInstance(params.id, body);
          if (!view) {
            set.status = 404;
            return { error: "Instance not found" };
          }
          logger.info({ providerInstanceId: view.id }, "Provider instance atualizada via HTTP");
          return { data: view, warning: RESTART_WARNING };
        } catch (err) {
          if (err instanceof ZApiRefreshError) {
            set.status = 502;
            return { error: `Falha ao sincronizar com a Z-API: ${err.message}` };
          }
          throw err;
        }
      },
      {
        params: "providerInstances.id.params",
        body: "providerInstances.update.body",
        response: {
          200: "providerInstances.update.response",
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          502: errorResponseSchema,
        },
        detail: {
          summary: "Atualiza campos da instância (dispara refresh; rollback em falha)",
        },
      }
    )
    .post(
      "/:id/refresh",
      async ({ params, set }) => {
        try {
          const view = await instanceService.refreshZApiInstance(params.id);
          if (!view) {
            set.status = 404;
            return { error: "Instance not found" };
          }
          logger.info({ providerInstanceId: view.id }, "Provider instance refreshada via HTTP");
          return { data: view };
        } catch (err) {
          if (err instanceof ZApiRefreshError) {
            set.status = 502;
            return {
              error: `Instância marcada como unreachable: ${err.message}`,
            };
          }
          throw err;
        }
      },
      {
        params: "providerInstances.id.params",
        response: {
          200: "providerInstances.refresh.response",
          401: errorResponseSchema,
          404: errorResponseSchema,
          502: errorResponseSchema,
        },
        detail: {
          summary: "Sincroniza status com a Z-API (ejeta do pool em falha)",
        },
      }
    )
    .patch(
      "/:id/enable",
      async ({ params, set }) => {
        const view = await instanceService.enable(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        logger.info({ providerInstanceId: view.id }, "Provider instance habilitada via HTTP");
        return { data: view, warning: RESTART_WARNING };
      },
      {
        params: "providerInstances.id.params",
        response: {
          200: "providerInstances.toggle.response",
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Habilita uma provider instance (idempotente)" },
      }
    )
    .patch(
      "/:id/disable",
      async ({ params, set }) => {
        const view = await instanceService.disable(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        logger.info({ providerInstanceId: view.id }, "Provider instance desabilitada via HTTP");
        return { data: view, warning: RESTART_WARNING };
      },
      {
        params: "providerInstances.id.params",
        response: {
          200: "providerInstances.toggle.response",
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Desabilita uma provider instance (idempotente)" },
      }
    );
}
