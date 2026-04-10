import type { DeleteMessagePayload } from "../jobs/types.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";

/**
 * Apaga uma mensagem via Z-API.
 *
 * Este é o lugar para lógica de negócio relacionada à exclusão:
 * validações adicionais, enriquecimento de contexto, tratamento de
 * erros específicos deste tipo de operação, etc.
 */
export async function deleteMessage(
  payload: DeleteMessagePayload,
  gateway: ZApiExecutor
): Promise<void> {
  await gateway.execute((client) => client.deleteMessage(payload));
}
