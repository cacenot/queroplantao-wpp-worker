import { beforeEach, describe, expect, it } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.AMQP_QUEUE = "test-queue";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_INSTANCES = JSON.stringify([
  { instance_id: "i1", instance_token: "t1", client_token: "c1" },
]);
process.env.HTTP_API_KEY = VALID_API_KEY;
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.DATABASE_URL = "postgres://ignored";
process.env.QP_ADMIN_API_URL = "https://admin.example.com";
process.env.QP_ADMIN_API_TOKEN = "admin-token";
process.env.MODERATION_VERSION = "v1";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = "test-webhook-secret";

const { Elysia } = await import("elysia");
const { randomUUID } = await import("node:crypto");
const { providerInstancesModule } = await import("./index.ts");
const { MessagingProviderInstanceService } = await import(
  "../../../services/messaging-provider-instance/index.ts"
);

import type {
  EnabledZApiRow,
  InstanceFilters,
  InstanceWithZApi,
  Pagination,
} from "../../../db/repositories/messaging-provider-instance-repository.ts";
import type {
  MessagingProviderInstance,
  NewMessagingProviderInstance,
  NewZApiInstance,
  ZApiInstance,
} from "../../../db/schema/provider-registry.ts";

class FakeRepository {
  private base = new Map<string, MessagingProviderInstance>();
  private zapi = new Map<string, ZApiInstance>();

  async findById(id: string): Promise<InstanceWithZApi | null> {
    const base = this.base.get(id);
    if (!base) return null;
    return { base, zapi: this.zapi.get(id) ?? null };
  }

  async list(
    filters: InstanceFilters,
    pagination: Pagination
  ): Promise<{ rows: InstanceWithZApi[]; total: number }> {
    let all = Array.from(this.base.values()).filter((b) => b.archivedAt === null);
    if (filters.protocol) all = all.filter((b) => b.protocol === filters.protocol);
    if (filters.providerKind) all = all.filter((b) => b.providerKind === filters.providerKind);
    if (typeof filters.isEnabled === "boolean") {
      all = all.filter((b) => b.isEnabled === filters.isEnabled);
    }
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const rows = all
      .slice(pagination.offset, pagination.offset + pagination.limit)
      .map((base) => ({ base, zapi: this.zapi.get(base.id) ?? null }));
    return { rows, total: all.length };
  }

  async listEnabledZApiRows(): Promise<EnabledZApiRow[]> {
    return [];
  }

  async existsByZapiInstanceId(zapiInstanceId: string): Promise<boolean> {
    for (const z of this.zapi.values()) {
      if (z.zapiInstanceId === zapiInstanceId) return true;
    }
    return false;
  }

  async insertZApiInstance(
    base: NewMessagingProviderInstance,
    zapi: Omit<NewZApiInstance, "messagingProviderInstanceId">
  ): Promise<{ id: string }> {
    const id = randomUUID();
    const now = new Date();

    const baseRow: MessagingProviderInstance = {
      id,
      protocol: base.protocol,
      providerKind: base.providerKind,
      displayName: base.displayName,
      isEnabled: base.isEnabled ?? true,
      executionStrategy: base.executionStrategy ?? "leased",
      redisKey: base.redisKey,
      safetyTtlMs: base.safetyTtlMs ?? null,
      heartbeatIntervalMs: base.heartbeatIntervalMs ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    const zapiRow: ZApiInstance = {
      messagingProviderInstanceId: id,
      zapiInstanceId: zapi.zapiInstanceId,
      instanceToken: zapi.instanceToken,
      webhookBaseUrl: zapi.webhookBaseUrl ?? null,
      currentConnectionState: null,
      currentStatusReason: null,
      currentConnected: null,
      currentSmartphoneConnected: null,
      currentPhoneNumber: null,
      currentProfileName: null,
      currentProfileAbout: null,
      currentProfileImageUrl: null,
      currentOriginalDevice: null,
      currentSessionId: null,
      currentDeviceSessionName: null,
      currentDeviceModel: null,
      currentIsBusiness: null,
      lastStatusSyncedAt: null,
      lastDeviceSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.base.set(id, baseRow);
    this.zapi.set(id, zapiRow);

    return { id };
  }

  async setEnabled(id: string, isEnabled: boolean): Promise<MessagingProviderInstance | null> {
    const existing = this.base.get(id);
    if (!existing) return null;
    const updated: MessagingProviderInstance = {
      ...existing,
      isEnabled,
      updatedAt: new Date(Date.now() + 1),
    };
    this.base.set(id, updated);
    return updated;
  }

  async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({});
  }
}

interface InstanceViewResp {
  id: string;
  isEnabled: boolean;
  displayName: string;
  updatedAt: string;
  zapi: {
    zapiInstanceId: string;
    instanceTokenMasked: string;
  } | null;
  [key: string]: unknown;
}

interface OkResp {
  data: InstanceViewResp;
  warning?: string;
}

interface ListResp {
  data: InstanceViewResp[];
  pagination: { limit: number; offset: number; total: number };
}

interface ErrorResp {
  error: string;
  details?: unknown;
}

let repo: FakeRepository;
let app: ReturnType<typeof buildApp>;

function buildApp(repository: FakeRepository) {
  // biome-ignore lint/suspicious/noExplicitAny: fake repository compat
  const service = new MessagingProviderInstanceService(repository as any);
  return new Elysia().use(providerInstancesModule({ instanceService: service }));
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

beforeEach(() => {
  repo = new FakeRepository();
  app = buildApp(repo);
});

describe("POST /providers/instances", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(
      app,
      "/providers/instances",
      {
        method: "POST",
        body: JSON.stringify({
          displayName: "inst",
          zapiInstanceId: "i1",
          instanceToken: "tokenabcdef",
          redisKey: "messaging:whatsapp",
        }),
      },
      null
    );
    expect(res.status).toBe(401);
  });

  it("401 com api key errada", async () => {
    const res = await makeRequest(
      app,
      "/providers/instances",
      {
        method: "POST",
        body: JSON.stringify({
          displayName: "inst",
          zapiInstanceId: "i1",
          instanceToken: "tokenabcdef",
          redisKey: "messaging:whatsapp",
        }),
      },
      "wrong-key"
    );
    expect(res.status).toBe(401);
  });

  it("201 no happy path com body mínimo", async () => {
    const res = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "i1",
        instanceToken: "supersecret1234",
        redisKey: "messaging:whatsapp",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResp;
    expect(body.data.displayName).toBe("inst-01");
    expect(body.data.isEnabled).toBe(true);
    expect(body.data.redisKey).toBe("messaging:whatsapp");
    expect(body.data.zapi?.zapiInstanceId).toBe("i1");
    expect(body.data.zapi?.instanceTokenMasked).toBe("supe...1234");
    expect(body.warning).toContain("restart");
    // biome-ignore lint/suspicious/noExplicitAny: runtime shape check
    expect((body.data.zapi as any).instanceToken).toBeUndefined();
  });

  it("422 quando displayName falta", async () => {
    const res = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
        redisKey: "messaging:whatsapp",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("422 quando redisKey falta", async () => {
    const res = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("409 quando zapiInstanceId duplicado", async () => {
    await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "dup",
        instanceToken: "tokenabcdef",
        redisKey: "messaging:whatsapp",
      }),
    });

    const res = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-02",
        zapiInstanceId: "dup",
        instanceToken: "other-token-value",
        redisKey: "messaging:whatsapp",
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("zapiInstanceId");
  });
});

describe("GET /providers/instances/:id", () => {
  it("200 retorna instância existente com token mascarado", async () => {
    const created = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "i1",
        instanceToken: "supersecret1234",
        redisKey: "messaging:whatsapp",
      }),
    });
    const createdBody = (await created.json()) as OkResp;
    const id = createdBody.data.id;

    const res = await makeRequest(app, `/providers/instances/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.id).toBe(id);
    expect(body.data.zapi?.instanceTokenMasked).toBe("supe...1234");
  });

  it("422 se id não é uuid", async () => {
    const res = await makeRequest(app, "/providers/instances/not-a-uuid");
    expect(res.status).toBe(422);
  });

  it("404 se id não existe", async () => {
    const res = await makeRequest(app, `/providers/instances/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /providers/instances", () => {
  async function create(displayName: string, zapiInstanceId: string) {
    return makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName,
        zapiInstanceId,
        instanceToken: "tokenabcdef",
        redisKey: "messaging:whatsapp",
      }),
    });
  }

  it("200 com paginação default", async () => {
    await create("a", "i1");
    await create("b", "i2");

    const res = await makeRequest(app, "/providers/instances");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResp;
    expect(body.data.length).toBe(2);
    expect(body.pagination.limit).toBe(20);
    expect(body.pagination.offset).toBe(0);
    expect(body.pagination.total).toBe(2);
  });

  it("respeita filtro isEnabled=false", async () => {
    const r1 = await create("a", "i1");
    const id = ((await r1.json()) as OkResp).data.id;
    await create("b", "i2");
    await makeRequest(app, `/providers/instances/${id}/disable`, { method: "PATCH" });

    const res = await makeRequest(app, "/providers/instances?isEnabled=false");
    const body = (await res.json()) as ListResp;
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(id);
  });

  it("aplica limit e offset", async () => {
    await create("a", "i1");
    await create("b", "i2");
    await create("c", "i3");

    const res = await makeRequest(app, "/providers/instances?limit=1&offset=1");
    const body = (await res.json()) as ListResp;
    expect(body.data.length).toBe(1);
    expect(body.pagination.total).toBe(3);
  });
});

describe("PATCH /providers/instances/:id/disable e /enable", () => {
  async function createAndGetId() {
    const res = await makeRequest(app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
        redisKey: "messaging:whatsapp",
      }),
    });
    return ((await res.json()) as OkResp).data.id;
  }

  it("disable vira isEnabled=false e altera updatedAt", async () => {
    const id = await createAndGetId();
    const before = await makeRequest(app, `/providers/instances/${id}`);
    const beforeBody = (await before.json()) as OkResp;

    const res = await makeRequest(app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.isEnabled).toBe(false);
    expect(body.warning).toContain("restart");
    expect(body.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
  });

  it("disable é idempotente (segunda chamada não altera updatedAt)", async () => {
    const id = await createAndGetId();
    const first = await makeRequest(app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    const firstBody = (await first.json()) as OkResp;

    const second = await makeRequest(app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as OkResp;
    expect(secondBody.data.isEnabled).toBe(false);
    expect(secondBody.data.updatedAt).toBe(firstBody.data.updatedAt);
  });

  it("enable flipa de volta para isEnabled=true", async () => {
    const id = await createAndGetId();
    await makeRequest(app, `/providers/instances/${id}/disable`, { method: "PATCH" });
    const res = await makeRequest(app, `/providers/instances/${id}/enable`, {
      method: "PATCH",
    });
    const body = (await res.json()) as OkResp;
    expect(body.data.isEnabled).toBe(true);
  });

  it("404 para id inexistente", async () => {
    const res = await makeRequest(app, `/providers/instances/${randomUUID()}/disable`, {
      method: "PATCH",
    });
    expect(res.status).toBe(404);
  });
});
