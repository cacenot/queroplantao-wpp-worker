import { describe, expect, it, mock } from "bun:test";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { SendResult, WhatsAppExecutor } from "../../gateways/whatsapp/types.ts";
import { ZApiError, ZApiTimeoutError } from "../../gateways/whatsapp/zapi/client.ts";
import type { SendMessagePayload } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { sendMessage } from "./send-message.ts";

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const OUTBOUND_ID = "22222222-2222-2222-2222-222222222222";

const SEND_RESULT: SendResult = { externalMessageId: "wamid.123", raw: {} };

// Ignoramos o callback `(provider) => provider.sendX(...)` — só precisamos
// retornar um SendResult conhecido pra validar a action.
function makeExecutorReturning(result: SendResult): WhatsAppExecutor {
  return {
    execute: mock(() => Promise.resolve(result)) as unknown as WhatsAppExecutor["execute"],
  };
}

function makeExecutorRejecting(err: unknown): WhatsAppExecutor {
  return {
    execute: mock(() => Promise.reject(err)) as unknown as WhatsAppExecutor["execute"],
  };
}

function makeOutboundRepo() {
  return {
    markSending: mock(() => Promise.resolve()),
    markSent: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
  } as unknown as OutboundMessagesRepository;
}

function buildPayload(content: SendMessagePayload["content"]): SendMessagePayload {
  return {
    providerInstanceId: PROVIDER_INSTANCE_ID,
    outboundMessageId: OUTBOUND_ID,
    target: { kind: "contact", externalId: "+5547997490248" },
    content,
  };
}

describe("sendMessage — happy paths", () => {
  it("text: marca sending, executa e marca sent", async () => {
    const executor = makeExecutorReturning(SEND_RESULT);
    const outboundMessagesRepo = makeOutboundRepo();

    await sendMessage(buildPayload({ kind: "text", message: "olá" }), {
      executor,
      outboundMessagesRepo,
    });

    expect(outboundMessagesRepo.markSending).toHaveBeenCalledWith(OUTBOUND_ID);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(outboundMessagesRepo.markSent).toHaveBeenCalledWith(OUTBOUND_ID, "wamid.123");
  });

  it("image, video, link, location, buttons: passam pelo dispatch sem erro", async () => {
    const cases: Array<SendMessagePayload["content"]> = [
      { kind: "image", imageUrl: "https://x.com/a.jpg" },
      { kind: "video", videoUrl: "https://x.com/v.mp4", caption: "ok" },
      { kind: "link", message: "veja", linkUrl: "https://x.com" },
      { kind: "location", latitude: -27.6, longitude: -48.5 },
      {
        kind: "buttons",
        message: "escolha",
        buttons: [{ id: "1", label: "A" }],
      },
    ];

    for (const content of cases) {
      const executor = makeExecutorReturning(SEND_RESULT);
      const outboundMessagesRepo = makeOutboundRepo();
      await sendMessage(buildPayload(content), { executor, outboundMessagesRepo });
      expect(outboundMessagesRepo.markSent).toHaveBeenCalledTimes(1);
    }
  });
});

describe("sendMessage — classificação de erro", () => {
  it("4xx Z-API → NonRetryableError + markFailed com status e body preservados", async () => {
    const zapiBody = { error: "Phone number doesn't exist." };
    const error = new ZApiError("Bad Request", 400, zapiBody);
    const executor = makeExecutorRejecting(error);
    const outboundMessagesRepo = makeOutboundRepo();

    await expect(
      sendMessage(buildPayload({ kind: "text", message: "olá" }), {
        executor,
        outboundMessagesRepo,
      })
    ).rejects.toBeInstanceOf(NonRetryableError);

    expect(outboundMessagesRepo.markFailed).toHaveBeenCalledTimes(1);
    expect(outboundMessagesRepo.markSent).toHaveBeenCalledTimes(0);

    // Body da Z-API preservado em outbound_messages.error — diagnóstico operacional.
    const markFailedCall = (outboundMessagesRepo.markFailed as unknown as ReturnType<typeof mock>)
      .mock.calls[0]?.[1] as { status?: number; body?: unknown };
    expect(markFailedCall.status).toBe(400);
    expect(markFailedCall.body).toEqual(zapiBody);
  });

  it("timeout Z-API → propaga retryable, sem markFailed", async () => {
    const error = new ZApiTimeoutError("https://x", 1000);
    const executor = makeExecutorRejecting(error);
    const outboundMessagesRepo = makeOutboundRepo();

    await expect(
      sendMessage(buildPayload({ kind: "text", message: "olá" }), {
        executor,
        outboundMessagesRepo,
      })
    ).rejects.toBe(error);

    expect(outboundMessagesRepo.markFailed).toHaveBeenCalledTimes(0);
    expect(outboundMessagesRepo.markSent).toHaveBeenCalledTimes(0);
  });

  it("5xx Z-API → propaga retryable, sem markFailed", async () => {
    const error = new ZApiError("Bad Gateway", 502, null);
    const executor = makeExecutorRejecting(error);
    const outboundMessagesRepo = makeOutboundRepo();

    await expect(
      sendMessage(buildPayload({ kind: "text", message: "olá" }), {
        executor,
        outboundMessagesRepo,
      })
    ).rejects.toBe(error);

    expect(outboundMessagesRepo.markFailed).toHaveBeenCalledTimes(0);
  });

  it("erro genérico (rede, etc) → propaga retryable", async () => {
    const error = new Error("ECONNRESET");
    const executor = makeExecutorRejecting(error);
    const outboundMessagesRepo = makeOutboundRepo();

    await expect(
      sendMessage(buildPayload({ kind: "text", message: "olá" }), {
        executor,
        outboundMessagesRepo,
      })
    ).rejects.toBe(error);
    expect(outboundMessagesRepo.markFailed).toHaveBeenCalledTimes(0);
  });
});

describe("sendMessage — best-effort em side effects", () => {
  it("falha no markSending não aborta o envio", async () => {
    const executor = makeExecutorReturning(SEND_RESULT);
    const outboundMessagesRepo = makeOutboundRepo();
    (outboundMessagesRepo.markSending as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error("DB down"))
    );

    await sendMessage(buildPayload({ kind: "text", message: "olá" }), {
      executor,
      outboundMessagesRepo,
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(outboundMessagesRepo.markSent).toHaveBeenCalledTimes(1);
  });

  it("falha no markSent não propaga — envio já concluiu no provider", async () => {
    const executor = makeExecutorReturning(SEND_RESULT);
    const outboundMessagesRepo = makeOutboundRepo();
    (outboundMessagesRepo.markSent as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error("DB down"))
    );

    await expect(
      sendMessage(buildPayload({ kind: "text", message: "olá" }), {
        executor,
        outboundMessagesRepo,
      })
    ).resolves.toBeUndefined();
  });
});
