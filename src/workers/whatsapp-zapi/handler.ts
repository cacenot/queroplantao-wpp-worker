import { acceptGroupInvite } from "../../actions/whatsapp/accept-group-invite.ts";
import { deleteMessage } from "../../actions/whatsapp/delete-message.ts";
import { removeParticipant } from "../../actions/whatsapp/remove-participant.ts";
import { sendMessage } from "../../actions/whatsapp/send-message.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { GatewayRegistry } from "../../gateways/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../../gateways/whatsapp/types.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { warnOnFail } from "../../lib/log-helpers.ts";
import { logger } from "../../lib/logger.ts";
import { normalizeOutboundError } from "../../services/outbound-messages/error.ts";

export type ZapiExecuteDeps = {
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  groupMessagesRepo: GroupMessagesRepository;
  outboundMessagesRepo: OutboundMessagesRepository;
};

function resolveExecutor(
  registry: GatewayRegistry<WhatsAppProvider>,
  providerInstanceId: string
): WhatsAppExecutor {
  const executor = registry.getByInstanceId(providerInstanceId);
  if (!executor) {
    throw new NonRetryableError(`Provider instance desconhecido no worker: ${providerInstanceId}`);
  }
  return executor;
}

export function createZapiExecuteJob(deps: ZapiExecuteDeps) {
  return async function executeJob(job: JobSchema): Promise<void> {
    switch (job.type) {
      case "whatsapp.delete_message":
        return deleteMessage(job.payload, {
          executor: resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId),
          groupMessagesRepo: deps.groupMessagesRepo,
        });
      case "whatsapp.remove_participant":
        return removeParticipant(
          job.payload,
          resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId)
        );
      case "whatsapp.join_group_via_invite":
        return acceptGroupInvite(
          job.payload,
          resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId)
        );
      case "whatsapp.send_message":
        return sendMessage(job.payload, {
          executor: resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId),
          outboundMessagesRepo: deps.outboundMessagesRepo,
        });
      case "whatsapp.moderate_group_message":
      case "whatsapp.ingest_participant_event":
        throw new NonRetryableError(
          `zapi-worker recebeu job ${job.type} (${job.id}) — routing quebrado`
        );
    }
  };
}

/**
 * Sincroniza `outbound_messages.status = failed` quando um job de envio vai
 * para a DLQ (NonRetryable ou retries esgotados). Espelha o estado terminal
 * de `tasks` na tabela de observabilidade. Demais tipos de job são ignorados.
 *
 * O `markFailed` no repositório filtra `status NOT IN ('failed','sent')` —
 * single-writer principle. Quando a action já marcou em 4xx (com `status` e
 * `body` da Z-API), este UPDATE vira no-op e o contexto rico é preservado.
 */
export function createZapiTerminalFailureHandler(repo: OutboundMessagesRepository) {
  return async function onTerminalFailure(job: JobSchema, err: unknown): Promise<void> {
    if (job.type !== "whatsapp.send_message") return;
    const log = logger.child({ outboundMessageId: job.payload.outboundMessageId });
    await repo
      .markFailed(job.payload.outboundMessageId, normalizeOutboundError(err))
      .catch(warnOnFail(log, "Falha ao sincronizar outbound como failed em DLQ"));
  };
}
