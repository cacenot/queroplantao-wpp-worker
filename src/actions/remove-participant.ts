import type { RemoveParticipantPayload } from "../jobs/types.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";

/**
 * Remove participantes de um grupo via Z-API.
 *
 * Este é o lugar para lógica de negócio relacionada à remoção:
 * validações adicionais, tratamento de erros específicos (ex: participante
 * já removido), notificações, etc.
 */
export async function removeParticipant(
  payload: RemoveParticipantPayload,
  gateway: ZApiExecutor
): Promise<void> {
  const result = await gateway.execute((client) => client.removeParticipant(payload));

  if (!result.value) {
    throw new Error(
      `Z-API retornou value=false ao remover participantes do grupo ${payload.groupId}`
    );
  }
}
