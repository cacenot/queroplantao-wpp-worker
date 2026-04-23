import { beforeEach, describe, expect, it } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";
const VALID_ID = "00000000-0000-0000-0000-000000000001";

process.env.AMQP_URL = "amqp://localhost";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN = "test-client-token";
process.env.HTTP_API_KEY = VALID_API_KEY;
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.DATABASE_URL = "postgres://ignored";
process.env.QP_ADMIN_API_URL = "https://admin.example.com";
process.env.QP_ADMIN_API_TOKEN = "admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN = "service-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = "test-webhook-secret";

const { Elysia } = await import("elysia");
const { phoneBypassModule } = await import("./index.ts");
const { ConflictError, NotFoundError } = await import("../../../services/phone-policies/index.ts");

import type { PhonePoliciesPagination } from "../../../db/repositories/phone-policies-repository.ts";
import type {
  AddPhonePolicyInput,
  ListPhonePoliciesFilters,
  ListPhonePoliciesResult,
  PhonePoliciesService,
  PhonePolicyView,
} from "../../../services/phone-policies/index.ts";

function makeView(overrides: Partial<PhonePolicyView> = {}): PhonePolicyView {
  return {
    id: VALID_ID,
    protocol: "whatsapp",
    kind: "bypass",
    phone: "+5511987654321",
    senderExternalId: null,
    groupExternalId: null,
    source: "manual",
    reason: null,
    notes: null,
    moderationId: null,
    metadata: {},
    expiresAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

type FakeService = {
  add: (input: AddPhonePolicyInput) => Promise<PhonePolicyView>;
  get: (id: string) => Promise<PhonePolicyView | null>;
  remove: (id: string) => Promise<void>;
  list: (
    filters: ListPhonePoliciesFilters,
    pagination: PhonePoliciesPagination
  ) => Promise<ListPhonePoliciesResult>;
};

function buildApp(overrides: Partial<FakeService>) {
  const full: FakeService = {
    add: async () => makeView(),
    get: async () => makeView(),
    remove: async () => {},
    list: async () => ({
      data: [makeView()],
      pagination: { limit: 20, offset: 0, total: 1 },
    }),
    ...overrides,
  };
  return new Elysia().use(
    phoneBypassModule({ phonePoliciesService: full as unknown as PhonePoliciesService })
  );
}

function makeRequest(
  app: ReturnType<typeof buildApp>,
  path: string,
  init: RequestInit = {},
  apiKey: string | null = VALID_API_KEY
) {
  const headers = new Headers(init.headers ?? {});
  if (apiKey !== null && !headers.has("x-api-key")) {
    headers.set("x-api-key", apiKey);
  }
  if (!headers.has("content-type") && init.body) {
    headers.set("content-type", "application/json");
  }
  return app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
}

type OkResp<T> = { data: T };
type ErrorResp = { error: string };

let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  app = buildApp({});
});

describe("POST /admin/moderation/bypass", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(
      app,
      "/admin/moderation/bypass",
      { method: "POST", body: JSON.stringify({ protocol: "whatsapp", phone: "+5511987654321" }) },
      null
    );
    expect(res.status).toBe(401);
  });

  it("201 no happy path", async () => {
    const res = await makeRequest(app, "/admin/moderation/bypass", {
      method: "POST",
      body: JSON.stringify({ protocol: "whatsapp", phone: "+5511987654321" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResp<PhonePolicyView>;
    expect(body.data.kind).toBe("bypass");
    expect(body.data.phone).toBe("+5511987654321");
  });

  it("422 quando phone tem formato inválido", async () => {
    const res = await makeRequest(app, "/admin/moderation/bypass", {
      method: "POST",
      body: JSON.stringify({ protocol: "whatsapp", phone: "55119" }),
    });
    expect(res.status).toBe(422);
  });

  it("409 quando ConflictError (entrada duplicada)", async () => {
    app = buildApp({
      add: async () => {
        throw new ConflictError("Política já existe");
      },
    });
    const res = await makeRequest(app, "/admin/moderation/bypass", {
      method: "POST",
      body: JSON.stringify({ protocol: "whatsapp", phone: "+5511987654321" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("Política já existe");
  });

  it("201 aceita só senderExternalId (sem phone)", async () => {
    let captured: AddPhonePolicyInput | undefined;
    app = buildApp({
      add: async (input) => {
        captured = input;
        return makeView({ phone: null, senderExternalId: "1234567890@lid" });
      },
    });
    const res = await makeRequest(app, "/admin/moderation/bypass", {
      method: "POST",
      body: JSON.stringify({
        protocol: "whatsapp",
        senderExternalId: "1234567890@lid",
      }),
    });
    expect(res.status).toBe(201);
    expect(captured?.senderExternalId).toBe("1234567890@lid");
  });

  it("400 quando nem phone nem senderExternalId são passados", async () => {
    const { ValidationError } = await import("../../../services/phone-policies/index.ts");
    app = buildApp({
      add: async () => {
        throw new ValidationError("Pelo menos um de `phone` ou `senderExternalId` é obrigatório");
      },
    });
    const res = await makeRequest(app, "/admin/moderation/bypass", {
      method: "POST",
      body: JSON.stringify({ protocol: "whatsapp" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/moderation/bypass", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(app, "/admin/moderation/bypass", {}, null);
    expect(res.status).toBe(401);
  });

  it("200 retorna lista paginada", async () => {
    const res = await makeRequest(app, "/admin/moderation/bypass");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: PhonePolicyView[]; pagination: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("passa kind=bypass para o service", async () => {
    let capturedKind: string | undefined;
    app = buildApp({
      list: async (filters) => {
        capturedKind = filters.kind;
        return { data: [], pagination: { limit: 20, offset: 0, total: 0 } };
      },
    });
    await makeRequest(app, "/admin/moderation/bypass");
    expect(capturedKind).toBe("bypass");
  });
});

describe("GET /admin/moderation/bypass/:id", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`, {}, null);
    expect(res.status).toBe(401);
  });

  it("200 retorna entry de bypass", async () => {
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp<PhonePolicyView>;
    expect(body.data.id).toBe(VALID_ID);
  });

  it("404 quando id não existe", async () => {
    app = buildApp({ get: async () => null });
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`);
    expect(res.status).toBe(404);
  });

  it("404 quando id pertence a entrada blacklist (cross-kind)", async () => {
    app = buildApp({ get: async () => makeView({ kind: "blacklist" }) });
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/moderation/bypass/:id", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(
      app,
      `/admin/moderation/bypass/${VALID_ID}`,
      { method: "DELETE" },
      null
    );
    expect(res.status).toBe(401);
  });

  it("204 no happy path", async () => {
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("404 quando entry não existe", async () => {
    app = buildApp({
      remove: async () => {
        throw new NotFoundError("não encontrada");
      },
    });
    const res = await makeRequest(app, `/admin/moderation/bypass/${VALID_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("não encontrada");
  });
});
