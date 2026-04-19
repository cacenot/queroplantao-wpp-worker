import type { RemoveParticipantPayload, WhatsAppExecutor } from "../../gateways/whatsapp/types.ts";

/**
 * Remove participantes de um grupo WhatsApp.
 *
 * Este é o lugar para lógica de negócio relacionada à remoção:
 * validações adicionais, tratamento de erros específicos (ex: participante
 * já removido), notificações, etc.
 */
export async function removeParticipant(
  payload: RemoveParticipantPayload,
  executor: WhatsAppExecutor
): Promise<void> {
  const result = await executor.execute((provider) => provider.removeParticipant(payload));

  if (!result.value) {
    throw new Error(
      `Provider retornou value=false ao remover participantes do grupo ${payload.groupId}`
    );
  }
}
