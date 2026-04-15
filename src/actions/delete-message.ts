import type { DeleteMessagePayload } from "../jobs/types.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";

export async function deleteMessage(
  payload: DeleteMessagePayload,
  gateway: ZApiExecutor
): Promise<void> {
  await gateway.execute((client) => client.deleteMessage(payload));
}
