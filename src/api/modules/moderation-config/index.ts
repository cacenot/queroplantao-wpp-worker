import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import {
  ConflictError,
  type ModerationConfigService,
  NotFoundError,
} from "../../../services/moderation-config/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import {
  activateResponseSchema,
  activeResponseSchema,
  createResponseSchema,
  listResponseSchema,
  moderationConfigModel,
} from "./model.ts";

export interface ModerationConfigModuleDeps {
  moderationConfigService: ModerationConfigService;
}

export function moderationConfigModule(deps: ModerationConfigModuleDeps) {
  const { moderationConfigService } = deps;

  return new Elysia({
    name: "moderation-config-module",
    prefix: "/admin/moderation/config",
    tags: ["moderation"],
  })
    .use(authPlugin)
    .use(moderationConfigModel)
    .get(
      "/active",
      async ({ set }) => {
        try {
          const data = await moderationConfigService.getActive();
          return { data };
        } catch (err) {
          if (err instanceof NotFoundError) {
            set.status = 404;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        response: {
          200: activeResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Retorna a config de moderação ativa" },
      }
    )
    .get(
      "/",
      async ({ query }) => {
        const limit = Math.min(Math.max(query.limit ?? 10, 1), 100);
        const data = await moderationConfigService.listHistory(limit);
        return { data };
      },
      {
        query: "moderationConfig.list.query",
        response: {
          200: listResponseSchema,
          401: errorResponseSchema,
        },
        detail: { summary: "Lista histórico de configs de moderação" },
      }
    )
    .post(
      "/",
      async ({ body, set }) => {
        try {
          const data = await moderationConfigService.createConfig(body);
          logger.info(
            { version: data.version, primaryModel: data.primaryModel },
            "Moderation config criada + ativada via HTTP"
          );
          set.status = 201;
          return { data };
        } catch (err) {
          if (err instanceof ConflictError) {
            set.status = 409;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        body: "moderationConfig.create.body",
        response: {
          201: createResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
        detail: { summary: "Cria e ativa uma nova config de moderação" },
      }
    )
    .post(
      "/:version/activate",
      async ({ params, set }) => {
        try {
          const data = await moderationConfigService.activate(params.version);
          logger.info({ version: data.version }, "Moderation config ativada via HTTP");
          return { data };
        } catch (err) {
          if (err instanceof NotFoundError) {
            set.status = 404;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        params: "moderationConfig.version.params",
        response: {
          200: activateResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Ativa uma config pelo version (rollback)" },
      }
    );
}
