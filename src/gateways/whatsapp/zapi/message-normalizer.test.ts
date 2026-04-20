import { describe, expect, it } from "bun:test";
import { extractZapiGroupMessage } from "./message-normalizer.ts";
import type { ZapiReceivedWebhookPayload } from "./webhook-schema.ts";

function base(overrides: Partial<ZapiReceivedWebhookPayload> = {}): ZapiReceivedWebhookPayload {
  return {
    instanceId: "3D0000",
    messageId: "msg-1",
    phone: "120363@g.us",
    connectedPhone: "5511999999999",
    chatName: "Grupo Teste",
    senderName: "Fulano",
    participantPhone: "5511888888888",
    participantLid: "1111:1@lid",
    fromMe: false,
    isGroup: true,
    isNewsletter: false,
    broadcast: false,
    type: "ReceivedCallback",
    momment: 1_700_000_000_000,
    ...overrides,
  };
}

describe("extractZapiGroupMessage - ignored", () => {
  it("não-grupo", () => {
    const r = extractZapiGroupMessage(base({ isGroup: false }));
    expect(r.status).toBe("ignored");
    if (r.status === "ignored") expect(r.reason).toBe("not-group");
  });

  it("newsletter", () => {
    const r = extractZapiGroupMessage(base({ isNewsletter: true }));
    if (r.status === "ignored") expect(r.reason).toBe("newsletter");
    else throw new Error("esperado ignored");
  });

  it("broadcast", () => {
    const r = extractZapiGroupMessage(base({ broadcast: true }));
    if (r.status === "ignored") expect(r.reason).toBe("broadcast");
    else throw new Error("esperado ignored");
  });

  it("from-me", () => {
    const r = extractZapiGroupMessage(base({ fromMe: true, text: { message: "oi" } }));
    if (r.status === "ignored") expect(r.reason).toBe("from-me");
    else throw new Error("esperado ignored");
  });

  it("notification", () => {
    const r = extractZapiGroupMessage(base({ notification: "GROUP_PARTICIPANT_ADD" }));
    if (r.status === "ignored") expect(r.reason).toBe("notification");
    else throw new Error("esperado ignored");
  });

  it("status-reply (ReplyMessage + status=STATUS)", () => {
    const r = extractZapiGroupMessage(base({ type: "ReplyMessage", status: "STATUS" }));
    if (r.status === "ignored") expect(r.reason).toBe("status-reply");
    else throw new Error("esperado ignored");
  });

  it("waitingMessage", () => {
    const r = extractZapiGroupMessage(base({ waitingMessage: true }));
    if (r.status === "ignored") expect(r.reason).toBe("waiting-message");
    else throw new Error("esperado ignored");
  });

  it("audio", () => {
    const r = extractZapiGroupMessage(base({ audio: { audioUrl: "http://x/a.ogg" } }));
    if (r.status === "ignored") expect(r.reason).toBe("audio");
    else throw new Error("esperado ignored");
  });

  it("sticker", () => {
    const r = extractZapiGroupMessage(base({ sticker: { stickerUrl: "http://x/s.webp" } }));
    if (r.status === "ignored") expect(r.reason).toBe("sticker");
    else throw new Error("esperado ignored");
  });

  it("reaction", () => {
    const r = extractZapiGroupMessage(base({ reaction: { value: "👍" } }));
    if (r.status === "ignored") expect(r.reason).toBe("reaction");
    else throw new Error("esperado ignored");
  });

  it("gif via mimeType image/gif", () => {
    const r = extractZapiGroupMessage(base({ image: { imageUrl: "x", mimeType: "image/gif" } }));
    if (r.status === "ignored") expect(r.reason).toBe("gif");
    else throw new Error("esperado ignored");
  });

  it("gif via video gif mimeType", () => {
    const r = extractZapiGroupMessage(base({ video: { videoUrl: "x", mimeType: "video/x-gif" } }));
    if (r.status === "ignored") expect(r.reason).toBe("gif");
    else throw new Error("esperado ignored");
  });

  it("missing-identifiers quando participante inexistente", () => {
    const r = extractZapiGroupMessage(
      base({
        participantPhone: undefined,
        participantLid: undefined,
        text: { message: "oi" },
      })
    );
    if (r.status === "ignored") expect(r.reason).toBe("missing-identifiers");
    else throw new Error("esperado ignored");
  });

  it("unsupported-content quando payload não carrega conteúdo conhecido", () => {
    const r = extractZapiGroupMessage(base({}));
    if (r.status === "ignored") expect(r.reason).toBe("unsupported-content");
    else throw new Error("esperado ignored");
  });

  it("no-text-content quando imagem sem caption", () => {
    const r = extractZapiGroupMessage(
      base({ image: { imageUrl: "http://x/i.jpg", mimeType: "image/jpeg" } })
    );
    if (r.status === "ignored") expect(r.reason).toBe("no-text-content");
    else throw new Error("esperado ignored");
  });
});

describe("extractZapiGroupMessage - accepted", () => {
  it("extrai texto simples", () => {
    const r = extractZapiGroupMessage(base({ text: { message: "  olá mundo  " } }));
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.messageType).toBe("text");
    expect(r.data.normalizedText).toBe("olá mundo");
    expect(r.data.hasText).toBe(true);
    expect(r.data.groupExternalId).toBe("120363@g.us");
    expect(r.data.senderPhone).toBe("+5511888888888");
    expect(r.data.senderExternalId).toBe("1111:1@lid");
    expect(r.data.zapi.instanceExternalId).toBe("3D0000");
  });

  it("extrai imagem com caption (texto vem do caption)", () => {
    const r = extractZapiGroupMessage(
      base({ image: { imageUrl: "http://x/i.jpg", mimeType: "image/jpeg", caption: "vaga" } })
    );
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.messageType).toBe("image");
    expect(r.data.caption).toBe("vaga");
    expect(r.data.mediaUrl).toBe("http://x/i.jpg");
    expect(r.data.mimeType).toBe("image/jpeg");
    expect(r.data.hasText).toBe(false);
  });

  it("extrai video com caption", () => {
    const r = extractZapiGroupMessage(
      base({ video: { videoUrl: "http://x/v.mp4", mimeType: "video/mp4", caption: "olha" } })
    );
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.messageType).toBe("video");
    expect(r.data.caption).toBe("olha");
  });

  it("extrai hydratedTemplate", () => {
    const r = extractZapiGroupMessage(
      base({
        hydratedTemplate: {
          message: "vaga aberta",
          title: "Urgente",
          footer: "QP",
          buttons: [],
        },
      })
    );
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.messageType).toBe("interactive");
    expect(r.data.messageSubtype).toBe("hydrated_template");
    expect(r.data.normalizedText).toBe("vaga aberta");
  });

  it("marca isForwarded e isEdited", () => {
    const r = extractZapiGroupMessage(
      base({ text: { message: "oi" }, forwarded: true, isEdit: true })
    );
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.isForwarded).toBe(true);
    expect(r.data.isEdited).toBe(true);
  });

  it("preserva rawPayload no zapi.rawPayload", () => {
    const payload = base({ text: { message: "oi" } });
    const r = extractZapiGroupMessage(payload);
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.zapi.rawPayload).toBe(payload);
  });

  it("lida com momment em segundos", () => {
    const r = extractZapiGroupMessage(base({ text: { message: "oi" }, momment: 1_700_000_000 }));
    if (r.status !== "accepted") throw new Error("esperado accepted");
    expect(r.data.sentAt.getTime()).toBe(1_700_000_000 * 1000);
  });
});
