import { beforeEach, describe, expect, it } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.AMQP_QUEUE = "test-queue";
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
const { moderationConfigModule } = await import("./index.ts");
const { messageAnalysisSchema } = await import("../../../ai/moderator.ts");
const { CATEGORIES } = await import("../../../ai/categories.ts");
const { ConflictError, NotFoundError } = await import(
  "../../../services/moderation-config/index.ts"
);

import type {
  CreateModerationConfigInput,
  ModerationConfig,
  ModerationConfigService,
} from "../../../services/moderation-config/index.ts";

function makeConfig(overrides: Partial<ModerationConfig> = {}): ModerationConfig {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    version: "v1",
    primaryModel: "openai/gpt-4o-mini",
    escalationModel: null,
    escalationThreshold: null,
    escalationCategories: [],
    systemPrompt: "sys prompt",
    examples: [],
    contentHash: "abc",
    isActive: true,
    activatedAt: "2026-04-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

type FakeService = {
  getActive: () => Promise<ModerationConfig>;
  listHistory: (limit: number) => Promise<ModerationConfig[]>;
  createConfig: (input: CreateModerationConfigInput) => Promise<ModerationConfig>;
  activate: (version: string) => Promise<ModerationConfig>;
};

function buildApp(service: Partial<FakeService>) {
  const full: FakeService = {
    getActive: async () => makeConfig(),
    listHistory: async () => [],
    createConfig: async (input) => makeConfig({ ...input, version: input.version }),
    activate: async (version) => makeConfig({ version }),
    ...service,
  };
  return new Elysia().use(
    moderationConfigModule({
      moderationConfigService: full as unknown as ModerationConfigService,
    })
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

describe("GET /admin/moderation/config/active", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(app, "/admin/moderation/config/active", {}, null);
    expect(res.status).toBe(401);
  });

  it("200 retorna config ativa", async () => {
    const res = await makeRequest(app, "/admin/moderation/config/active");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp<ModerationConfig>;
    expect(body.data.isActive).toBe(true);
    expect(body.data.version).toBe("v1");
  });

  it("404 quando não há config ativa", async () => {
    app = buildApp({
      getActive: async () => {
        throw new NotFoundError("vazio");
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config/active");
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/moderation/config (histórico)", () => {
  it("200 e default limit 10", async () => {
    let requestedLimit = 0;
    app = buildApp({
      listHistory: async (limit) => {
        requestedLimit = limit;
        return [makeConfig()];
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config");
    expect(res.status).toBe(200);
    expect(requestedLimit).toBe(10);
  });

  it("respeita limit query", async () => {
    let requestedLimit = 0;
    app = buildApp({
      listHistory: async (limit) => {
        requestedLimit = limit;
        return [];
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config?limit=25");
    expect(res.status).toBe(200);
    expect(requestedLimit).toBe(25);
  });
});

describe("POST /admin/moderation/config", () => {
  it("201 no happy path com body mínimo", async () => {
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        version: "2026-04-new",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "você é um moderador...",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResp<ModerationConfig>;
    expect(body.data.version).toBe("2026-04-new");
  });

  it("201 sem version — delega ao service para auto-gerar", async () => {
    const captured: { input?: CreateModerationConfigInput } = {};
    app = buildApp({
      createConfig: async (input) => {
        captured.input = input;
        return makeConfig({ version: "2026-04-v7" });
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "você é um moderador...",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResp<ModerationConfig>;
    expect(body.data.version).toBe("2026-04-v7");
    expect(captured.input?.version).toBeUndefined();
  });

  it("422 quando systemPrompt falta", async () => {
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        version: "x",
        primaryModel: "openai/gpt-4o-mini",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 quando example tem category inválida", async () => {
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        version: "x",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "s",
        examples: [
          {
            text: "hi",
            analysis: {
              reason: "r",
              partner: null,
              category: "nao_existe",
              confidence: 0.9,
              action: "allow",
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("409 quando ConflictError (version duplicada)", async () => {
    app = buildApp({
      createConfig: async () => {
        throw new ConflictError("duplicada");
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        version: "dup",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "s",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("duplicada");
  });

  it("422 quando escalationThreshold > 1", async () => {
    const res = await makeRequest(app, "/admin/moderation/config", {
      method: "POST",
      body: JSON.stringify({
        version: "x",
        primaryModel: "openai/gpt-4o-mini",
        systemPrompt: "s",
        escalationThreshold: 1.5,
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe("POST /admin/moderation/config/:version/activate", () => {
  it("200 ativa e retorna config", async () => {
    const res = await makeRequest(app, "/admin/moderation/config/v1/activate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp<ModerationConfig>;
    expect(body.data.version).toBe("v1");
  });

  it("404 quando version não existe", async () => {
    app = buildApp({
      activate: async () => {
        throw new NotFoundError("não existe");
      },
    });
    const res = await makeRequest(app, "/admin/moderation/config/ausente/activate", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("contrato TypeBox ↔ Zod em examples", () => {
  it("qualquer category válida no TypeBox também passa no Zod do moderator", () => {
    for (const category of CATEGORIES) {
      const parsed = messageAnalysisSchema.safeParse({
        reason: "r",
        partner: null,
        category,
        confidence: 0.5,
        action: "allow",
      });
      expect(parsed.success).toBe(true);
    }
  });
});
