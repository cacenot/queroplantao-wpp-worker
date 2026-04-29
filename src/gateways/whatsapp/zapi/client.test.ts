import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY = "test-api-key-secret";
process.env.ZAPI_BASE_URL ??= "https://api.z-api.io";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN ??= "test-service-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET ??= "test-webhook-secret";

const { ZApiClient, ZApiError } = await import("./client.ts");

type FetchCall = { url: string; body: unknown; headers: Record<string, string> };

let calls: FetchCall[] = [];
let fetchImpl: (url: string, options: RequestInit) => Promise<Response> = () =>
  Promise.resolve(
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  );

const originalFetch = globalThis.fetch;

function makeClient() {
  return new ZApiClient({
    providerInstanceId: "11111111-1111-1111-1111-111111111111",
    instance_id: "INST",
    instance_token: "TOK",
    client_token: "CLT",
  });
}

function recordFetch() {
  globalThis.fetch = mock(async (url: unknown, options: unknown) => {
    const opts = (options ?? {}) as RequestInit;
    const headers: Record<string, string> = {};
    if (opts.headers instanceof Headers) {
      opts.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body, headers });
    return fetchImpl(String(url), opts);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  fetchImpl = () =>
    Promise.resolve(
      new Response(JSON.stringify({ messageId: "wamid.123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  recordFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ZApiClient.sendText", () => {
  it("converte phone E.164 → digits puros para contact", async () => {
    const client = makeClient();
    await client.sendText({
      target: { kind: "contact", externalId: "+5547997490248" },
      message: "olá",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.z-api.io/instances/INST/token/TOK/send-text");
    expect(calls[0]?.body).toEqual({ phone: "5547997490248", message: "olá" });
    expect(calls[0]?.headers["client-token"]).toBe("CLT");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("groupId vai direto no campo `phone` para target.kind=group", async () => {
    const client = makeClient();
    await client.sendText({
      target: { kind: "group", externalId: "120363111111111111@g.us" },
      message: "oi grupo",
    });

    expect(calls[0]?.body).toEqual({
      phone: "120363111111111111@g.us",
      message: "oi grupo",
    });
  });

  it("extrai externalMessageId de `messageId`", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(JSON.stringify({ messageId: "abc-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const client = makeClient();
    const result = await client.sendText({
      target: { kind: "contact", externalId: "+5547997490248" },
      message: "olá",
    });
    expect(result.externalMessageId).toBe("abc-123");
  });

  it("fallback para `zaapId` quando ausente messageId", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(JSON.stringify({ zaapId: "zap-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const client = makeClient();
    const result = await client.sendText({
      target: { kind: "contact", externalId: "+5547997490248" },
      message: "olá",
    });
    expect(result.externalMessageId).toBe("zap-1");
  });

  it("4xx retorna ZApiError com status", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Bad" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        })
      );

    const client = makeClient();
    await expect(
      client.sendText({
        target: { kind: "contact", externalId: "+5547997490248" },
        message: "olá",
      })
    ).rejects.toBeInstanceOf(ZApiError);
  });
});

describe("ZApiClient.sendImage / Video / Link / Location / Buttons", () => {
  it("sendImage envia campo `image` (não `imageUrl`)", async () => {
    const client = makeClient();
    await client.sendImage({
      target: { kind: "contact", externalId: "+5547997490248" },
      imageUrl: "https://x.com/a.jpg",
      caption: "ok",
    });

    expect(calls[0]?.url).toContain("/send-image");
    expect(calls[0]?.body).toEqual({
      phone: "5547997490248",
      image: "https://x.com/a.jpg",
      caption: "ok",
    });
  });

  it("sendVideo envia campo `video` e omite caption se ausente", async () => {
    const client = makeClient();
    await client.sendVideo({
      target: { kind: "contact", externalId: "+5547997490248" },
      videoUrl: "https://x.com/v.mp4",
    });

    expect(calls[0]?.url).toContain("/send-video");
    expect(calls[0]?.body).toEqual({
      phone: "5547997490248",
      video: "https://x.com/v.mp4",
    });
  });

  it("sendLink envia campos linkUrl/title/linkDescription/image", async () => {
    const client = makeClient();
    await client.sendLink({
      target: { kind: "contact", externalId: "+5547997490248" },
      message: "veja",
      linkUrl: "https://x.com",
      title: "T",
    });

    expect(calls[0]?.url).toContain("/send-link");
    expect(calls[0]?.body).toEqual({
      phone: "5547997490248",
      message: "veja",
      linkUrl: "https://x.com",
      title: "T",
    });
  });

  it("sendLocation envia latitude/longitude e omite opcionais", async () => {
    const client = makeClient();
    await client.sendLocation({
      target: { kind: "contact", externalId: "+5547997490248" },
      latitude: -27.6,
      longitude: -48.5,
    });

    expect(calls[0]?.url).toContain("/send-location");
    expect(calls[0]?.body).toEqual({
      phone: "5547997490248",
      latitude: -27.6,
      longitude: -48.5,
    });
  });

  it("sendButtons mapeia para buttonActions com type=REPLY", async () => {
    const client = makeClient();
    await client.sendButtons({
      target: { kind: "contact", externalId: "+5547997490248" },
      message: "escolha",
      buttons: [
        { id: "1", label: "A" },
        { id: "2", label: "B" },
      ],
    });

    expect(calls[0]?.url).toContain("/send-button-actions");
    expect(calls[0]?.body).toEqual({
      phone: "5547997490248",
      message: "escolha",
      buttonActions: [
        { id: "1", type: "REPLY", label: "A" },
        { id: "2", type: "REPLY", label: "B" },
      ],
    });
  });
});
