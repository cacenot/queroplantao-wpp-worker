import { Elysia } from "elysia";
import { logger } from "../../lib/logger.ts";
import {
  ConflictError,
  type MessagingProviderInstanceService,
  RESTART_WARNING,
} from "../../services/messaging-provider-instance/index.ts";
import { authPlugin } from "../plugins/auth.ts";
import {
  createResponseSchema,
  createZApiInstanceBodySchema,
  errorResponseSchema,
  getResponseSchema,
  idParamSchema,
  listQuerySchema,
  listResponseSchema,
  toggleResponseSchema,
} from "../schemas/provider-instances.ts";

export function providerInstancesRoutes(service: MessagingProviderInstanceService) {
  return new Elysia({ prefix: "/providers/instances", tags: ["providers"] })
    .use(authPlugin)
    .post(
      "/",
      async ({ body, set }) => {
        try {
          const view = await service.createZApiInstance(body);
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
          throw err;
        }
      },
      {
        body: createZApiInstanceBodySchema,
        response: {
          201: createResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
        detail: { summary: "Cria uma instância Z-API no provider registry" },
      }
    )
    .get(
      "/",
      async ({ query }) => {
        const limit = clamp(query.limit ?? 20, 1, 100);
        const offset = Math.max(query.offset ?? 0, 0);

        const result = await service.list(
          {
            protocol: query.protocol,
            providerKind: query.providerKind,
            isEnabled: query.isEnabled,
          },
          { limit, offset }
        );

        return result;
      },
      {
        query: listQuerySchema,
        response: {
          200: listResponseSchema,
          401: errorResponseSchema,
        },
        detail: { summary: "Lista provider instances com paginação e filtros" },
      }
    )
    .get(
      "/:id",
      async ({ params, set }) => {
        const view = await service.get(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        return { data: view };
      },
      {
        params: idParamSchema,
        response: {
          200: getResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Retorna uma provider instance pelo id" },
      }
    )
    .patch(
      "/:id/enable",
      async ({ params, set }) => {
        const view = await service.enable(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        logger.info({ providerInstanceId: view.id }, "Provider instance habilitada via HTTP");
        return { data: view, warning: RESTART_WARNING };
      },
      {
        params: idParamSchema,
        response: {
          200: toggleResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Habilita uma provider instance (idempotente)" },
      }
    )
    .patch(
      "/:id/disable",
      async ({ params, set }) => {
        const view = await service.disable(params.id);
        if (!view) {
          set.status = 404;
          return { error: "Instance not found" };
        }
        logger.info({ providerInstanceId: view.id }, "Provider instance desabilitada via HTTP");
        return { data: view, warning: RESTART_WARNING };
      },
      {
        params: idParamSchema,
        response: {
          200: toggleResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Desabilita uma provider instance (idempotente)" },
      }
    );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
