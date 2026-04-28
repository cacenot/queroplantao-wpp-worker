import { describe, expect, it, mock } from "bun:test";
import type {
  AcceptGroupInviteResult,
  WhatsAppExecutor,
  WhatsAppProvider,
} from "../../gateways/whatsapp/types.ts";
import { ZApiError, ZApiTimeoutError } from "../../gateways/whatsapp/zapi/client.ts";
import type { JoinGroupViaInvitePayload } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { acceptGroupInvite } from "./accept-group-invite.ts";

const payload: JoinGroupViaInvitePayload = {
  providerInstanceId: "11111111-1111-1111-1111-111111111111",
  messagingGroupId: "22222222-2222-2222-2222-222222222222",
  inviteCode: "ABC123",
};

function executorFromProvider(p: Pick<WhatsAppProvider, "acceptGroupInvite">): WhatsAppExecutor {
  return {
    execute: ((fn) => fn(p as unknown as WhatsAppProvider)) as WhatsAppExecutor["execute"],
  };
}

describe("acceptGroupInvite", () => {
  it("resolve sem erro quando provider retorna success=true", async () => {
    const executor = executorFromProvider({
      acceptGroupInvite: mock(
        (): Promise<AcceptGroupInviteResult> => Promise.resolve({ success: true, raw: {} })
      ),
    });

    await expect(acceptGroupInvite(payload, executor)).resolves.toBeUndefined();
  });

  it("lança NonRetryableError quando provider retorna success=false", async () => {
    const executor = executorFromProvider({
      acceptGroupInvite: mock(
        (): Promise<AcceptGroupInviteResult> =>
          Promise.resolve({ success: false, raw: { error: "expired" } })
      ),
    });

    await expect(acceptGroupInvite(payload, executor)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("converte ZApiError 4xx em NonRetryableError", async () => {
    const executor: WhatsAppExecutor = {
      execute: mock(() =>
        Promise.reject(new ZApiError("Not Found", 404, { error: "invite invalid" }))
      ) as WhatsAppExecutor["execute"],
    };

    await expect(acceptGroupInvite(payload, executor)).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("propaga ZApiTimeoutError (retryable)", async () => {
    const executor: WhatsAppExecutor = {
      execute: mock(() =>
        Promise.reject(new ZApiTimeoutError("https://api.z-api.io/...", 10_000))
      ) as WhatsAppExecutor["execute"],
    };

    await expect(acceptGroupInvite(payload, executor)).rejects.toBeInstanceOf(ZApiTimeoutError);
  });

  it("propaga ZApiError 5xx como retryable (não NonRetryable)", async () => {
    const executor: WhatsAppExecutor = {
      execute: mock(() =>
        Promise.reject(new ZApiError("Bad Gateway", 502, "<html>"))
      ) as WhatsAppExecutor["execute"],
    };

    await expect(acceptGroupInvite(payload, executor)).rejects.toBeInstanceOf(ZApiError);
    await expect(acceptGroupInvite(payload, executor)).rejects.not.toBeInstanceOf(
      NonRetryableError
    );
  });
});
