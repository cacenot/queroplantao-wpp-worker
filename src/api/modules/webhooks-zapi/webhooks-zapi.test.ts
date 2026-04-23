import { beforeEach, describe, expect, it, mock } from "bun:test";

const WEBHOOK_SECRET = "test-webhook-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_INSTANCES = JSON.stringify([
  { instance_id: "i1", instance_token: "t1", client_token: "c1" },
]);
process.env.HTTP_API_KEY = "test-api-key";
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { Elysia } = await import("elysia");
const { webhooksZapiModule } = await import("./index.ts");

interface ErrorResp {
  error: string;
  details?: unknown;
}

function makeGroupMessagesService() {
  return {
    ingestZapi: mock(() =>
      Promise.resolve({ status: "queued", messageId: "m1", moderationId: "mod1" } as const)
    ),
  };
}

function makeInstanceService() {
  return {
    resolveProviderInstanceIdByZapiInstanceId: mock(() =>
      Promise.resolve("11111111-1111-1111-1111-111111111111")
    ),
  };
}

type MockGroupMessagesService = ReturnType<typeof makeGroupMessagesService>;
type MockInstanceService = ReturnType<typeof makeInstanceService>;

interface BuildOpts {
  groupMessagesService?: MockGroupMessagesService;
  instanceService?: MockInstanceService;
  secret?: string;
  enabled?: boolean;
}

function buildApp(opts: BuildOpts = {}) {
  return new Elysia().use(
    webhooksZapiModule({
      // biome-ignore lint/suspicious/noExplicitAny: mock cross-type compat
      groupMessagesService: (opts.groupMessagesService ?? makeGroupMessagesService()) as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock cross-type compat
      instanceService: (opts.instanceService ?? makeInstanceService()) as any,
      webhookSecret: opts.secret ?? WEBHOOK_SECRET,
      enabled: opts.enabled ?? true,
    })
  );
}

function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  rawBody?: string
) {
  const h = new Headers({ "content-type": "application/json", ...headers });
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: h,
      body: rawBody ?? JSON.stringify(body),
    })
  );
}

const ACCEPTED_TEXT_PAYLOAD = {
  instanceId: "i1",
  messageId: "msg-accepted-1",
  phone: "120363000000000000@g.us",
  chatName: "Grupo Teste",
  senderName: "Alice",
  participantPhone: "5511999990001",
  participantLid: "5511999990001@lid",
  isGroup: true,
  fromMe: false,
  momment: 1712000000000,
  text: { message: "mensagem de teste" },
};

let gms: MockGroupMessagesService;
let instances: MockInstanceService;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  gms = makeGroupMessagesService();
  instances = makeInstanceService();
  app = buildApp({ groupMessagesService: gms, instanceService: instances });
});

describe("POST /webhooks/zapi/on-message-received", () => {
  describe("enabled=false", () => {
    it("retorna 404 quando desabilitado", async () => {
      const disabled = buildApp({ enabled: false });
      const res = await post(
        disabled,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(res.status).toBe(404);
    });
  });

  describe("autenticação via secret", () => {
    it("401 sem secret", async () => {
      const res = await post(app, "/webhooks/zapi/on-message-received", ACCEPTED_TEXT_PAYLOAD);
      expect(res.status).toBe(401);
    });

    it("401 com secret errado em query", async () => {
      const res = await post(
        app,
        "/webhooks/zapi/on-message-received?secret=wrong",
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(res.status).toBe(401);
    });

    it("401 com secret errado em header", async () => {
      const res = await post(app, "/webhooks/zapi/on-message-received", ACCEPTED_TEXT_PAYLOAD, {
        "x-webhook-secret": "wrong",
      });
      expect(res.status).toBe(401);
    });

    it("202 com secret correto em query", async () => {
      const res = await post(
        app,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(res.status).toBe(202);
    });

    it("202 com secret correto em header", async () => {
      const res = await post(app, "/webhooks/zapi/on-message-received", ACCEPTED_TEXT_PAYLOAD, {
        "x-webhook-secret": WEBHOOK_SECRET,
      });
      expect(res.status).toBe(202);
    });
  });

  describe("validação do body", () => {
    it("400 quando JSON é inválido", async () => {
      const res = await post(
        app,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        null,
        {},
        "not-json{{{"
      );
      expect(res.status).toBe(400);
      const data = (await res.json()) as ErrorResp;
      expect(data.error).toBe("Invalid JSON");
    });

    it("400 quando payload não tem messageId (schema Z-API inválido)", async () => {
      const res = await post(app, `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`, {
        phone: "x@g.us",
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as ErrorResp;
      expect(data.error).toBe("Validation failed");
    });
  });

  describe("ignored (normalizer)", () => {
    it("202 ignored para newsletter", async () => {
      const res = await post(app, `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`, {
        ...ACCEPTED_TEXT_PAYLOAD,
        isNewsletter: true,
      });
      expect(res.status).toBe(202);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.status).toBe("ignored");
      expect(data.reason).toBe("newsletter");
      expect(gms.ingestZapi).not.toHaveBeenCalled();
    });

    it("202 ignored para fromMe", async () => {
      const res = await post(app, `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`, {
        ...ACCEPTED_TEXT_PAYLOAD,
        fromMe: true,
      });
      expect(res.status).toBe(202);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.reason).toBe("from-me");
      expect(gms.ingestZapi).not.toHaveBeenCalled();
    });

    it("202 ignored para não-grupo", async () => {
      const res = await post(app, `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`, {
        ...ACCEPTED_TEXT_PAYLOAD,
        isGroup: false,
      });
      expect(res.status).toBe(202);
      const data = (await res.json()) as { status: string; reason: string };
      expect(data.reason).toBe("not-group");
    });
  });

  describe("happy path", () => {
    it("202 delega para ingestZapi e retorna outcome", async () => {
      const res = await post(
        app,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(res.status).toBe(202);
      expect(gms.ingestZapi).toHaveBeenCalledTimes(1);
      const data = (await res.json()) as { status: string; messageId: string };
      expect(data.status).toBe("queued");
      expect(data.messageId).toBe("m1");
    });

    it("passa providerInstanceId resolvido", async () => {
      await post(
        app,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(instances.resolveProviderInstanceIdByZapiInstanceId).toHaveBeenCalledWith("i1");
      const call = gms.ingestZapi.mock.calls[0];
      expect(call).toBeDefined();
      if (!call) throw new Error("ingestZapi should have been called");
      const [, ctx] = call as unknown as [unknown, { providerInstanceId: string | null }];
      expect(ctx.providerInstanceId).toBe("11111111-1111-1111-1111-111111111111");
    });

    it("providerInstanceId=null quando resolver falha", async () => {
      const failingInstances = {
        resolveProviderInstanceIdByZapiInstanceId: mock(() => Promise.reject(new Error("boom"))),
      };
      const appWithFail = buildApp({
        groupMessagesService: gms,
        // biome-ignore lint/suspicious/noExplicitAny: mock cross-type compat
        instanceService: failingInstances as any,
      });

      const res = await post(
        appWithFail,
        `/webhooks/zapi/on-message-received?secret=${WEBHOOK_SECRET}`,
        ACCEPTED_TEXT_PAYLOAD
      );
      expect(res.status).toBe(202);
      const call = gms.ingestZapi.mock.calls[0];
      if (!call) throw new Error("ingestZapi should have been called");
      const [, ctx] = call as unknown as [unknown, { providerInstanceId: string | null }];
      expect(ctx.providerInstanceId).toBe(null);
    });
  });
});
