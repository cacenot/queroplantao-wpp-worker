import { describe, expect, it, mock } from "bun:test";
import type { DeleteMessagePayload } from "../jobs/types.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";
import { deleteMessage } from "./delete-message.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutor(impl: () => Promise<void> = () => Promise.resolve()): ZApiExecutor {
  return { execute: mock(impl) as ZApiExecutor["execute"] };
}

const payload: DeleteMessagePayload = {
  messageId: "msg-123",
  phone: "5511999990001",
  owner: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deleteMessage", () => {
  it("chama gateway.execute() exatamente uma vez", async () => {
    const gateway = makeExecutor();

    await deleteMessage(payload, gateway);

    expect(gateway.execute).toHaveBeenCalledTimes(1);
  });

  it("propaga erros lançados por gateway.execute()", async () => {
    const error = new Error("falha na Z-API");
    const gateway = makeExecutor(() => Promise.reject(error));

    await expect(deleteMessage(payload, gateway)).rejects.toThrow("falha na Z-API");
  });
});
