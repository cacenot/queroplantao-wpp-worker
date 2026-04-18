import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import {
  extractZapiGroupMessage,
  type NormalizedZapiMessage,
} from "../../../messaging/whatsapp/zapi/message-normalizer.ts";
import { zapiReceivedWebhookSchema } from "../../../messaging/whatsapp/zapi/webhook-schema.ts";
import type { GroupMessagesService } from "../../../services/group-messages/group-messages-service.ts";
import type { MessagingProviderInstanceService } from "../../../services/messaging-provider-instance/index.ts";

export interface WebhooksZapiDeps {
  groupMessagesService: GroupMessagesService;
  instanceService: MessagingProviderInstanceService;
  webhookSecret: string;
  enabled: boolean;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // timingSafeEqual exige buffers de mesmo tamanho — comparar o tamanho primeiro
  // não abre canal lateral porque o secret esperado tem tamanho fixo conhecido.
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function webhooksZapiRoutes(deps: WebhooksZapiDeps) {
  const { groupMessagesService, instanceService, webhookSecret, enabled } = deps;

  return new Elysia({ tags: ["webhooks"] }).post(
    "/webhooks/zapi/on-message-received",
    async ({ request, query, set }) => {
      if (!enabled) {
        set.status = 404;
        return { error: "Webhook desabilitado" };
      }

      const providedSecret =
        (typeof query.secret === "string" ? query.secret : null) ??
        request.headers.get("x-webhook-secret") ??
        "";

      if (!providedSecret || !constantTimeEqual(providedSecret, webhookSecret)) {
        set.status = 401;
        return { error: "Unauthorized" };
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        set.status = 400;
        return { error: "Invalid JSON" };
      }

      const parsed = zapiReceivedWebhookSchema.safeParse(body);
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.flatten() }, "Webhook Z-API com payload inválido");
        set.status = 400;
        return { error: "Validation failed", details: parsed.error.flatten() };
      }

      const result = extractZapiGroupMessage(parsed.data);
      if (result.status === "ignored") {
        logger.debug({ reason: result.reason }, "Webhook Z-API — mensagem descartada");
        set.status = 202;
        return { status: "ignored", reason: result.reason };
      }

      const providerInstanceId = await resolveProviderInstanceId(instanceService, result.data);

      const outcome = await groupMessagesService.ingestZapi(result.data, { providerInstanceId });

      set.status = 202;
      return outcome;
    },
    {
      parse: "none",
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
