import { describe, expect, it, mock } from "bun:test";
import type { DeleteMessagePayload, WhatsAppExecutor } from "../../messaging/whatsapp/types.ts";
import { deleteMessage } from "./delete-message.ts";

function makeExecutor(impl: () => Promise<void> = () => Promise.resolve()): WhatsAppExecutor {
  return { execute: mock(impl) as WhatsAppExecutor["execute"] };
}

const payload: DeleteMessagePayload = {
  messageId: "msg-123",
  phone: "5511999990001",
  owner: true,
};

describe("deleteMessage", () => {
  it("chama executor.execute() exatamente uma vez", async () => {
    const executor = makeExecutor();

    await deleteMessage(payload, executor);

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("propaga erros lançados por executor.execute()", async () => {
    const error = new Error("falha no provider");
    const executor = makeExecutor(() => Promise.reject(error));

    await expect(deleteMessage(payload, executor)).rejects.toThrow("falha no provider");
  });
});
