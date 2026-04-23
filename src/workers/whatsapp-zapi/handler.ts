import { deleteMessage } from "../../actions/whatsapp/delete-message.ts";
import { removeParticipant } from "../../actions/whatsapp/remove-participant.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { GatewayRegistry } from "../../gateways/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../../gateways/whatsapp/types.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";

export type ZapiExecuteDeps = {
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  groupMessagesRepo: GroupMessagesRepository;
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
      case "whatsapp.moderate_group_message":
        throw new NonRetryableError(
          `zapi-worker recebeu job de moderação (${job.id}) — routing quebrado`
        );
    }
  };
}
