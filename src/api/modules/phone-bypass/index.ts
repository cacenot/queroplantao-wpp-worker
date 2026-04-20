import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import {
  ConflictError,
  NotFoundError,
  type PhonePoliciesService,
} from "../../../services/phone-policies/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import {
  createResponseSchema,
  getResponseSchema,
  listResponseSchema,
  phoneBypassModel,
} from "./model.ts";

export interface PhoneBypassModuleDeps {
  phonePoliciesService: PhonePoliciesService;
}

export function phoneBypassModule(deps: PhoneBypassModuleDeps) {
  const { phonePoliciesService } = deps;

  return new Elysia({
    name: "phone-bypass-module",
    prefix: "/admin/moderation/bypass",
    tags: ["moderation"],
  })
    .use(authPlugin)
    .use(phoneBypassModel)
    .post(
      "/",
      async ({ body, set }) => {
        try {
          const data = await phonePoliciesService.add({ ...body, kind: "bypass" });
          logger.info({ id: data.id, phone: data.phone }, "Bypass entry criada via HTTP");
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
        body: "phoneBypass.create.body",
        response: {
          201: createResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
        },
        detail: { summary: "Adiciona número à lista de bypass" },
      }
    )
    .get(
      "/",
      async ({ query }) => {
        const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
        const offset = Math.max(query.offset ?? 0, 0);
        return phonePoliciesService.list(
          {
            kind: "bypass",
            protocol: query.protocol,
            phone: query.phone,
            groupExternalId: query.groupExternalId,
            source: query.source,
          },
          { limit, offset }
        );
      },
      {
        query: "phoneBypass.list.query",
        response: {
          200: listResponseSchema,
          401: errorResponseSchema,
        },
        detail: { summary: "Lista entradas de bypass" },
      }
    )
    .get(
      "/:id",
      async ({ params, set }) => {
        const view = await phonePoliciesService.get(params.id);
        if (!view || view.kind !== "bypass") {
          set.status = 404;
          return { error: "Entry not found" };
        }
        return { data: view };
      },
      {
        params: "phoneBypass.id.params",
        response: {
          200: getResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Retorna uma entrada de bypass pelo id" },
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
        params: "phoneBypass.id.params",
        response: {
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
        detail: { summary: "Remove uma entrada de bypass" },
      }
    );
}
