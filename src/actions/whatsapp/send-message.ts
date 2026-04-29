import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type {
  SendResult,
  WhatsAppExecutor,
  WhatsAppProvider,
} from "../../gateways/whatsapp/types.ts";
import { ZApiError, ZApiTimeoutError } from "../../gateways/whatsapp/zapi/client.ts";
import type { SendMessagePayload } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

type SendMessageDeps = {
  executor: WhatsAppExecutor;
  outboundMessagesRepo: OutboundMessagesRepository;
};

/**
 * Envia uma mensagem via Z-API e atualiza `outbound_messages` com o resultado.
 *
 * Classificação de erro:
 * - 4xx Z-API (≠ timeout) → `NonRetryableError` (DLQ direto). Marca outbound como `failed`.
 * - Timeout / 5xx / erro de rede → propaga (retryable). Outbound permanece em `sending`;
 *   próxima tentativa fará novo `markSending` e o ciclo recomeça.
 *
 * Side-effects de DB são best-effort: se `markSending`/`markSent` falham, o envio
 * no provider já aconteceu (ou não), e logamos warn em vez de propagar — evita
 * re-execução do envio só por causa do banco.
 */
export async function sendMessage(
  payload: SendMessagePayload,
  deps: SendMessageDeps
): Promise<void> {
  await deps.outboundMessagesRepo
    .markSending(payload.outboundMessageId)
    .catch((err: unknown) =>
      logger.warn(
        { err, outboundMessageId: payload.outboundMessageId },
        "Falha ao marcar outbound como sending — segue envio"
      )
    );

  let result: SendResult;
  try {
    result = await deps.executor.execute((provider) => dispatchSend(provider, payload));
  } catch (err) {
    // Timeout sempre é retryable — propaga (handler-base fará retry/DLQ).
    if (err instanceof ZApiTimeoutError) throw err;

    // Demais 4xx são permanentes (payload inválido, número inexistente, instância
    // não conectada). Marca terminal e DLQ direto.
    if (err instanceof ZApiError && err.status >= 400 && err.status < 500) {
      await deps.outboundMessagesRepo
        .markFailed(payload.outboundMessageId, normalizeError(err))
        .catch((repoErr: unknown) =>
          logger.warn(
            { err: repoErr, outboundMessageId: payload.outboundMessageId },
            "Falha ao marcar outbound como failed após 4xx Z-API"
          )
        );
      throw new NonRetryableError(
        `Z-API recusou envio (HTTP ${err.status}) para outboundMessageId=${payload.outboundMessageId}`,
        err
      );
    }

    throw err;
  }

  await deps.outboundMessagesRepo
    .markSent(payload.outboundMessageId, result.externalMessageId)
    .catch((err: unknown) =>
      logger.warn(
        {
          err,
          outboundMessageId: payload.outboundMessageId,
          externalMessageId: result.externalMessageId,
        },
        "Falha ao marcar outbound como sent — envio concluído no provider"
      )
    );
}

function dispatchSend(
  provider: WhatsAppProvider,
  payload: SendMessagePayload
): Promise<SendResult> {
  const { target, content } = payload;
  switch (content.kind) {
    case "text":
      return provider.sendText({ target, message: content.message });
    case "image":
      return provider.sendImage({
        target,
        imageUrl: content.imageUrl,
        caption: content.caption,
      });
    case "video":
      return provider.sendVideo({
        target,
        videoUrl: content.videoUrl,
        caption: content.caption,
      });
    case "link":
      return provider.sendLink({
        target,
        message: content.message,
        linkUrl: content.linkUrl,
        title: content.title,
        linkDescription: content.linkDescription,
        image: content.image,
      });
    case "location":
      return provider.sendLocation({
        target,
        latitude: content.latitude,
        longitude: content.longitude,
        title: content.title,
        address: content.address,
      });
    case "buttons":
      return provider.sendButtons({
        target,
        message: content.message,
        buttons: content.buttons,
        title: content.title,
        footer: content.footer,
      });
  }
}

function normalizeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}
