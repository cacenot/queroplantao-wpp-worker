import { Elysia } from "elysia";
import {
  extractZapiGroupMessage,
  type NormalizedZapiMessage,
} from "../../../gateways/whatsapp/zapi/message-normalizer.ts";
import { logger } from "../../../lib/logger.ts";
import type { GroupMessagesService } from "../../../services/group-messages/group-messages-service.ts";
import type { GroupParticipantsService } from "../../../services/group-participants/index.ts";
import type { MessagingProviderInstanceService } from "../../../services/messaging-provider-instance/index.ts";
import { bodyLimitPlugin } from "../../shared/body-limit.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import { timingSafeEqual } from "../../shared/timing-safe.ts";
import { webhooksZapiModel, zapiReceivedWebhookSchema } from "./model.ts";

const MAX_BODY_SIZE = 1 * 1024 * 1024;

export interface WebhooksZapiModuleDeps {
  groupMessagesService: GroupMessagesService;
  instanceService: MessagingProviderInstanceService;
  participantsService: GroupParticipantsService;
  webhookSecret: string;
  enabled: boolean;
}

export function webhooksZapiModule(deps: WebhooksZapiModuleDeps) {
  const { groupMessagesService, instanceService, participantsService, webhookSecret, enabled } =
    deps;

  return new Elysia({ name: "webhooks-zapi-module", tags: ["webhooks"] })
    .use(bodyLimitPlugin({ max: MAX_BODY_SIZE }))
    .use(webhooksZapiModel)
    .post(
      "/webhooks/zapi/on-message-received",
      async ({ body, query, headers, set }) => {
        if (!enabled) {
          set.status = 404;
          return { error: "Webhook desabilitado" };
        }

        const providedSecret =
          (typeof query.secret === "string" ? query.secret : null) ??
          headers["x-webhook-secret"] ??
          "";

        if (!providedSecret || !timingSafeEqual(providedSecret, webhookSecret)) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

        const parsed = zapiReceivedWebhookSchema.safeParse(body);
        if (!parsed.success) {
          logger.warn({ errors: parsed.error.flatten() }, "Webhook Z-API com payload inválido");
          set.status = 400;
          return { error: "Validation failed", details: parsed.error.flatten() };
        }

        // — 1. Evento de participante? (GROUP_PARTICIPANT_ADD/REMOVE/LEAVE/PROMOTE/DEMOTE,
        //   MEMBERSHIP_APPROVAL_REQUEST). Curto-circuito barato: só olha `notification`.
        const participantResult = await participantsService.ingestZapiWebhook(parsed.data);
        if (participantResult.status === "accepted") {
          set.status = 202;
          return {
            status: "accepted" as const,
            kind: "participant_event" as const,
            eventType: participantResult.eventType,
          };
        }
        // Se veio um `notification` mas não foi mapeado, NÃO é uma mensagem — loga
        // warn e retorna ignored sem passar pelo pipeline de mensagem (que seria
        // descartado de qualquer jeito e só paga parse extra).
        if (participantResult.reason === "unknown-notification") {
          logger.warn(
            { notification: participantResult.notification },
            "Webhook Z-API — notification desconhecida (não mapeada)"
          );
          set.status = 202;
          return { status: "ignored" as const, reason: "unknown-notification" as const };
        }

        // — 2. Pipeline normal de mensagem de grupo.
        const result = extractZapiGroupMessage(parsed.data);
        if (result.status === "ignored") {
          logger.debug({ reason: result.reason }, "Webhook Z-API — mensagem descartada");
          set.status = 202;
          return { status: "ignored" as const, reason: result.reason };
        }

        const providerInstanceId = await resolveProviderInstanceId(instanceService, result.data);
        const outcome = await groupMessagesService.ingestZapi(result.data, { providerInstanceId });

        set.status = 202;
        return outcome;
      },
      {
        response: {
          202: "webhooksZapi.ingest.response",
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          413: errorResponseSchema,
        },
        detail: { summary: "Recebe webhook on-message-received da Z-API" },
      }
    );
}

async function resolveProviderInstanceId(
  instanceService: MessagingProviderInstanceService,
  normalized: NormalizedZapiMessage
): Promise<string | null> {
  const zapiInstanceExternalId = normalized.zapi.instanceExternalId;
  if (!zapiInstanceExternalId) return null;

  try {
    return await instanceService.resolveProviderInstanceIdByZapiInstanceId(zapiInstanceExternalId);
  } catch (err) {
    logger.warn(
      { err, zapiInstanceExternalId },
      "Falha ao resolver providerInstanceId — seguindo com null"
    );
    return null;
  }
}
