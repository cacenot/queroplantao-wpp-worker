import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { DeleteMessagePayload, WhatsAppExecutor } from "../../gateways/whatsapp/types.ts";
import { logger } from "../../lib/logger.ts";

type DeleteMessageDeps = {
  executor: WhatsAppExecutor;
  groupMessagesRepo: GroupMessagesRepository;
};

export async function deleteMessage(
  payload: DeleteMessagePayload,
  deps: DeleteMessageDeps
): Promise<void> {
  await deps.executor.execute((provider) => provider.deleteMessage(payload));
  // `payload.phone` carrega o groupId em grupo (polimórfico — ver schemas.ts).
  // Em DM, o UPDATE simplesmente não matcha nenhuma linha (tabela é só de grupo).
  // Side-effect best-effort: se falhar, o delete no provider já rolou — retry
  // chamaria Z-API numa msg já deletada (erro espúrio). warn + continua.
  await deps.groupMessagesRepo
    .markRemoved(payload.messageId, payload.phone)
    .catch((err: unknown) =>
      logger.warn(
        { err, messageId: payload.messageId, phone: payload.phone },
        "Falha ao marcar removed_at — delete no provider já concluído"
      )
    );
}
