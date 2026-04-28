import type { AcceptGroupInviteResult, WhatsAppExecutor } from "../../gateways/whatsapp/types.ts";
import { ZApiError, ZApiTimeoutError } from "../../gateways/whatsapp/zapi/client.ts";
import type { JoinGroupViaInvitePayload } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

/**
 * Aceita convite de grupo via Z-API. Falhas conhecidas:
 *
 * - `success: false` no body → invite expirado/inválido/recusado: NonRetryableError (DLQ direto).
 * - HTTP 4xx (≠ timeout) → idem: configuração de instância ou invite ruim.
 * - Timeout / 5xx → erro normal (retryable até `AMQP_RETRY_MAX_RETRIES`).
 *
 * Não atualiza `group_participants` aqui — o evento `joined_invite_link` chega
 * via webhook e cuida do upsert pelo fluxo já existente.
 */
export async function acceptGroupInvite(
  payload: JoinGroupViaInvitePayload,
  executor: WhatsAppExecutor
): Promise<void> {
  let result: AcceptGroupInviteResult;
  try {
    result = await executor.execute((provider) => provider.acceptGroupInvite(payload.inviteCode));
  } catch (err) {
    if (err instanceof ZApiTimeoutError) throw err;
    if (err instanceof ZApiError && err.status >= 400 && err.status < 500) {
      throw new NonRetryableError(
        `Z-API recusou accept-group-invite (HTTP ${err.status}) para inviteCode=${payload.inviteCode}`,
        err
      );
    }
    throw err;
  }

  if (!result.success) {
    logger.warn(
      {
        providerInstanceId: payload.providerInstanceId,
        messagingGroupId: payload.messagingGroupId,
        inviteCode: payload.inviteCode,
        raw: result.raw,
      },
      "Z-API retornou success=false em accept-group-invite"
    );
    throw new NonRetryableError(
      `Z-API recusou accept-group-invite para inviteCode=${payload.inviteCode}`
    );
  }
}
