import { describe, expect, it, mock } from "bun:test";
import type { RemoveParticipantPayload, WhatsAppExecutor } from "../../messaging/whatsapp/types.ts";
import { removeParticipant } from "./remove-participant.ts";

function makeExecutor(value: boolean): WhatsAppExecutor {
  return {
    execute: mock(() => Promise.resolve({ value })) as WhatsAppExecutor["execute"],
  };
}

const payload: RemoveParticipantPayload = {
  groupId: "120363019502650977-group",
  phones: ["5511999990001", "5511999990002"],
};

describe("removeParticipant", () => {
  it("resolve sem erro quando provider retorna value=true", async () => {
    const executor = makeExecutor(true);

    await expect(removeParticipant(payload, executor)).resolves.toBeUndefined();
  });

  it("lança erro quando provider retorna value=false", async () => {
    const executor = makeExecutor(false);

    await expect(removeParticipant(payload, executor)).rejects.toThrow();
  });

  it("mensagem de erro contém o groupId quando value=false", async () => {
    const executor = makeExecutor(false);

    await expect(removeParticipant(payload, executor)).rejects.toThrow(payload.groupId);
  });

  it("propaga erros lançados por executor.execute()", async () => {
    const error = new Error("falha no provider");
    const executor: WhatsAppExecutor = { execute: mock(() => Promise.reject(error)) };

    await expect(removeParticipant(payload, executor)).rejects.toThrow("falha no provider");
  });
});
