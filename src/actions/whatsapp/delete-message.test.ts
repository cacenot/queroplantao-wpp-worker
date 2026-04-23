import { describe, expect, it, mock } from "bun:test";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { DeleteMessagePayload, WhatsAppExecutor } from "../../gateways/whatsapp/types.ts";
import { deleteMessage } from "./delete-message.ts";

function makeExecutor(impl: () => Promise<void> = () => Promise.resolve()): WhatsAppExecutor {
  return { execute: mock(impl) as WhatsAppExecutor["execute"] };
}

function makeRepo(impl: () => Promise<number> = () => Promise.resolve(1)) {
  return {
    markRemoved: mock(impl),
  } as unknown as GroupMessagesRepository;
}

const payload: DeleteMessagePayload = {
  messageId: "msg-123",
  phone: "120363111111111111@g.us",
  owner: true,
};

describe("deleteMessage", () => {
  it("chama executor.execute() e marca removed_at no repo", async () => {
    const executor = makeExecutor();
    const groupMessagesRepo = makeRepo();

    await deleteMessage(payload, { executor, groupMessagesRepo });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(groupMessagesRepo.markRemoved).toHaveBeenCalledWith(payload.messageId, payload.phone);
  });

  it("propaga erros lançados por executor.execute() sem marcar removed_at", async () => {
    const error = new Error("falha no provider");
    const executor = makeExecutor(() => Promise.reject(error));
    const groupMessagesRepo = makeRepo();

    await expect(deleteMessage(payload, { executor, groupMessagesRepo })).rejects.toThrow(
      "falha no provider"
    );
    expect(groupMessagesRepo.markRemoved).toHaveBeenCalledTimes(0);
  });

  it("não propaga falha do markRemoved — delete no provider é irreversível", async () => {
    const executor = makeExecutor();
    const groupMessagesRepo = makeRepo(() => Promise.reject(new Error("DB down")));

    await expect(deleteMessage(payload, { executor, groupMessagesRepo })).resolves.toBeUndefined();
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(groupMessagesRepo.markRemoved).toHaveBeenCalledTimes(1);
  });
});
