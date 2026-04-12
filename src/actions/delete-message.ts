import type { DeleteMessagePayload } from "../jobs/types.ts";
import type { Sql } from "../lib/db.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";

export async function deleteMessage(
  payload: DeleteMessagePayload,
  gateway: ZApiExecutor,
  sql: Sql
): Promise<void> {
  await gateway.execute((client) => client.deleteMessage(payload));
  await sql`UPDATE zapi_group_messages SET removed = true WHERE external_message_id = ${payload.messageId}`;
}
