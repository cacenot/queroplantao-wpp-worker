import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import {
  ConflictError,
  NotFoundError,
  type PhonePoliciesService,
  ValidationError,
} from "../../../services/phone-policies/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import {
  createResponseSchema,
  getResponseSchema,
  listResponseSchema,
  phoneBlacklistModel,
} from "./model.ts";

export interface PhoneBlacklistModuleDeps {
  phonePoliciesService: PhonePoliciesService;
}

export function phoneBlacklistModule(deps: PhoneBlacklistModuleDeps) {
  const { phonePoliciesService } = deps;

  return new Elysia({
    name: "phone-blacklist-module",
    prefix: "/admin/moderation/blacklist",
    tags: ["moderation"],
  })
    .use(authPlugin)
    .use(phoneBlacklistModel)
    .post(
      "/",
      async ({ body, set }) => {
        try {
          const data = await phonePoliciesService.add({ ...body, kind: "blacklist" });
          logger.info(
            { id: data.id, phone: data.phone, senderExternalId: data.senderExternalId },
            "Blacklist entry criada via HTTP"
          );
          set.status = 201;
          return { data };
        } catch (err) {
          if (err instanceof ValidationError) {
            set.status = 400;
            return { error: err.message };
          }
          if (err instanceof ConflictError) {
            set.status = 409;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        body: "phoneBlacklist.create.body",
        response: {
          201: createResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
        detail: { summary: "Adiciona número à blacklist" },
      }
    )
    .get(
      "/",
      async ({ query }) => {
        const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
        const offset = Math.max(query.offset ?? 0, 0);
        return phonePoliciesService.list(
          {
            kind: "blacklist",
            protocol: query.protocol,
            phone: query.phone,
            senderExternalId: query.senderExternalId,
            groupExternalId: query.groupExternalId,
            source: query.source,
          },
          { limit, offset }
        );
      },
      {
        query: "phoneBlacklist.list.query",
        response: {
          200: listResponseSchema,
          401: errorResponseSchema,
        },
        detail: { summary: "Lista entradas da blacklist" },
      }
    )
    .get(
      "/:id",
      async ({ params, set }) => {
        const view = await phonePoliciesService.get(params.id);
        if (!view || view.kind !== "blacklist") {
          set.status = 404;
          return { error: "Entry not found" };
        }
        return { data: view };
      },
      {
        params: "phoneBlacklist.id.params",
        response: {
          200: getResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Retorna uma entrada da blacklist pelo id" },
      }
    )
    .delete(
      "/:id",
      async ({ params, set }) => {
        try {
          await phonePoliciesService.remove(params.id);
          set.status = 204;
        } catch (err) {
          if (err instanceof NotFoundError) {
            set.status = 404;
            return { error: err.message };
          }
          throw err;
        }
      },
      {
        params: "phoneBlacklist.id.params",
        response: {
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Remove uma entrada da blacklist" },
      }
    );
}
