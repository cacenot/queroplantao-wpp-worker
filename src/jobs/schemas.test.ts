import { describe, expect, it } from "bun:test";
import { jobSchema, sendMessageJobSchema } from "./schemas.ts";

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const OUTBOUND_ID = "22222222-2222-2222-2222-222222222222";
const JOB_ID = "33333333-3333-3333-3333-333333333333";
const NOW_ISO = "2026-04-29T00:00:00.000Z";

function buildJob(overrides: { content: unknown; target?: unknown }) {
  return {
    id: JOB_ID,
    type: "whatsapp.send_message" as const,
    createdAt: NOW_ISO,
    payload: {
      providerInstanceId: PROVIDER_INSTANCE_ID,
      outboundMessageId: OUTBOUND_ID,
      target: overrides.target ?? { kind: "contact", externalId: "+5547997490248" },
      content: overrides.content,
    },
  };
}

describe("sendMessageJobSchema — content válidos", () => {
  it("text", () => {
    expect(
      sendMessageJobSchema.safeParse(buildJob({ content: { kind: "text", message: "olá" } }))
        .success
    ).toBe(true);
  });

  it("image com URL HTTPS", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({ content: { kind: "image", imageUrl: "https://x.com/a.jpg" } })
      ).success
    ).toBe(true);
  });

  it("video com caption", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({
          content: { kind: "video", videoUrl: "https://x.com/v.mp4", caption: "veja" },
        })
      ).success
    ).toBe(true);
  });

  it("link com todos os campos opcionais", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({
          content: {
            kind: "link",
            message: "veja",
            linkUrl: "https://x.com/post",
            title: "Título",
            linkDescription: "desc",
            image: "https://x.com/preview.jpg",
          },
        })
      ).success
    ).toBe(true);
  });

  it("location dentro dos limites geo", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({
          content: { kind: "location", latitude: -27.6, longitude: -48.5, title: "Floripa" },
        })
      ).success
    ).toBe(true);
  });

  it("buttons com 3 botões", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({
          content: {
            kind: "buttons",
            message: "escolha",
            buttons: [
              { id: "1", label: "A" },
              { id: "2", label: "B" },
              { id: "3", label: "C" },
            ],
          },
        })
      ).success
    ).toBe(true);
  });
});

describe("sendMessageJobSchema — content inválidos", () => {
  it("imageUrl com formato inválido é rejeitada", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({ content: { kind: "image", imageUrl: "not-a-url" } })
      ).success
    ).toBe(false);
  });

  it("buttons com 4+ botões é rejeitado (limite WhatsApp)", () => {
    const buttons = [1, 2, 3, 4].map((n) => ({ id: String(n), label: `B${n}` }));
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({ content: { kind: "buttons", message: "x", buttons } })
      ).success
    ).toBe(false);
  });

  it("buttons sem botões é rejeitado", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({ content: { kind: "buttons", message: "x", buttons: [] } })
      ).success
    ).toBe(false);
  });

  it("location com latitude fora do range", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({ content: { kind: "location", latitude: 200, longitude: 0 } })
      ).success
    ).toBe(false);
  });

  it("text com message vazia", () => {
    expect(
      sendMessageJobSchema.safeParse(buildJob({ content: { kind: "text", message: "" } })).success
    ).toBe(false);
  });

  it("target.kind desconhecido é rejeitado", () => {
    expect(
      sendMessageJobSchema.safeParse(
        buildJob({
          target: { kind: "broadcast", externalId: "x" },
          content: { kind: "text", message: "olá" },
        })
      ).success
    ).toBe(false);
  });
});

describe("jobSchema (discriminated union)", () => {
  it("aceita whatsapp.send_message dentro do union", () => {
    const result = jobSchema.safeParse(buildJob({ content: { kind: "text", message: "olá" } }));
    expect(result.success).toBe(true);
  });
});
