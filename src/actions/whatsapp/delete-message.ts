import type { DeleteMessagePayload, WhatsAppExecutor } from "../../messaging/whatsapp/types.ts";

export async function deleteMessage(
  payload: DeleteMessagePayload,
  executor: WhatsAppExecutor
): Promise<void> {
  await executor.execute((provider) => provider.deleteMessage(payload));
}
