import { describe, expect, it, mock } from "bun:test";
import type { RemoveParticipantPayload } from "../jobs/types.ts";
import type { ZApiExecutor } from "../zapi/gateway.ts";
import { removeParticipant } from "./remove-participant.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutor(value: boolean): ZApiExecutor {
  return { execute: mock(() => Promise.resolve({ value })) as ZApiExecutor["execute"] };
}

const payload: RemoveParticipantPayload = {
  groupId: "120363019502650977-group",
  phones: ["5511999990001", "5511999990002"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("removeParticipant", () => {
  it("resolve sem erro quando Z-API retorna value=true", async () => {
    const gateway = makeExecutor(true);

    await expect(removeParticipant(payload, gateway)).resolves.toBeUndefined();
  });

  it("lança erro quando Z-API retorna value=false", async () => {
    const gateway = makeExecutor(false);

    await expect(removeParticipant(payload, gateway)).rejects.toThrow();
  });

  it("mensagem de erro contém o groupId quando value=false", async () => {
    const gateway = makeExecutor(false);

    await expect(removeParticipant(payload, gateway)).rejects.toThrow(payload.groupId);
  });

  it("propaga erros lançados por gateway.execute()", async () => {
    const error = new Error("falha na Z-API");
    const gateway: ZApiExecutor = { execute: mock(() => Promise.reject(error)) };

    await expect(removeParticipant(payload, gateway)).rejects.toThrow("falha na Z-API");
  });
});
