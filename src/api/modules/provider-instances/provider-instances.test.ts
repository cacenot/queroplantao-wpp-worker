import { beforeEach, describe, expect, it } from "bun:test";

const VALID_API_KEY = "test-api-key-secret";

process.env.AMQP_URL = "amqp://localhost";
process.env.ZAPI_BASE_URL = "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN = "env-client-token";
process.env.HTTP_API_KEY = VALID_API_KEY;
process.env.HTTP_PORT = "0";
process.env.REDIS_URL = "redis://localhost:6379";
process.env.DATABASE_URL = "postgres://ignored";
process.env.QP_ADMIN_API_URL = "https://admin.example.com";
process.env.QP_ADMIN_API_TOKEN = "admin-token";
process.env.QP_ADMIN_API_SERVICE_TOKEN = "service-token";
process.env.ZAPI_RECEIVED_WEBHOOK_SECRET = "test-webhook-secret";

const { Elysia } = await import("elysia");
const { randomUUID } = await import("node:crypto");
const { providerInstancesModule } = await import("./index.ts");
const { MessagingProviderInstanceService } = await import(
  "../../../services/messaging-provider-instance/index.ts"
);

import type {
  ConnectionEventInsert,
  DeviceSnapshotInsert,
  EnabledZApiRow,
  InstanceFilters,
  InstanceWithZApi,
  Pagination,
  UpdateBasePatch,
  ZApiCurrentStatusUpdate,
} from "../../../db/repositories/messaging-provider-instance-repository.ts";
import type {
  MessagingProviderInstance,
  NewMessagingProviderInstance,
  NewZApiInstance,
  ZApiInstance,
} from "../../../db/schema/provider-registry.ts";
import type {
  ZApiClientCredentials,
  ZApiRefreshClient,
} from "../../../services/messaging-provider-instance/messaging-provider-instance-service.ts";

type SnapshotResult = Awaited<ReturnType<ZApiRefreshClient["refreshSnapshot"]>>;

class FakeRepository {
  public base = new Map<string, MessagingProviderInstance>();
  public zapi = new Map<string, ZApiInstance>();
  public connectionEvents: Array<{ providerInstanceId: string; event: ConnectionEventInsert }> = [];
  public deviceSnapshots: Array<{
    providerInstanceId: string;
    snapshot: DeviceSnapshotInsert;
  }> = [];

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
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    const zapiRow: ZApiInstance = {
      messagingProviderInstanceId: id,
      zapiInstanceId: zapi.zapiInstanceId,
      instanceToken: zapi.instanceToken,
      customClientToken: zapi.customClientToken ?? null,
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

  async updateBase(id: string, patch: UpdateBasePatch): Promise<MessagingProviderInstance | null> {
    const existing = this.base.get(id);
    if (!existing) return null;
    const updated: MessagingProviderInstance = {
      ...existing,
      displayName: patch.displayName ?? existing.displayName,
      executionStrategy: patch.executionStrategy ?? existing.executionStrategy,
      redisKey: patch.redisKey ?? existing.redisKey,
      updatedAt: new Date(Date.now() + 1),
    };
    this.base.set(id, updated);
    return updated;
  }

  async updateZApiCredentials(
    id: string,
    patch: { instanceToken?: string; customClientToken?: string | null }
  ): Promise<ZApiInstance | null> {
    const existing = this.zapi.get(id);
    if (!existing) return null;
    const updated: ZApiInstance = {
      ...existing,
      instanceToken: patch.instanceToken ?? existing.instanceToken,
      customClientToken:
        patch.customClientToken !== undefined
          ? patch.customClientToken
          : existing.customClientToken,
      updatedAt: new Date(Date.now() + 1),
    };
    this.zapi.set(id, updated);
    return updated;
  }

  async updateZApiCurrentStatus(id: string, snapshot: ZApiCurrentStatusUpdate): Promise<void> {
    const existing = this.zapi.get(id);
    if (!existing) return;
    const now = new Date();
    this.zapi.set(id, {
      ...existing,
      ...snapshot,
      lastStatusSyncedAt: now,
      lastDeviceSyncedAt: now,
      updatedAt: now,
    });
  }

  async insertConnectionEvent(
    providerInstanceId: string,
    event: ConnectionEventInsert
  ): Promise<void> {
    this.connectionEvents.push({ providerInstanceId, event });
  }

  async insertDeviceSnapshot(
    providerInstanceId: string,
    snapshot: DeviceSnapshotInsert
  ): Promise<void> {
    this.deviceSnapshots.push({ providerInstanceId, snapshot });
  }

  async markUnreachableAndDisable(id: string, reason: string): Promise<void> {
    const now = new Date();
    const baseExisting = this.base.get(id);
    const zapiExisting = this.zapi.get(id);
    if (baseExisting) {
      this.base.set(id, { ...baseExisting, isEnabled: false, updatedAt: now });
    }
    if (zapiExisting) {
      this.zapi.set(id, {
        ...zapiExisting,
        currentConnectionState: "unreachable",
        currentStatusReason: reason,
        currentConnected: false,
        lastStatusSyncedAt: now,
        updatedAt: now,
      });
    }
  }

  async withTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const baseSnapshot = new Map(this.base);
    const zapiSnapshot = new Map(this.zapi);
    const eventsLen = this.connectionEvents.length;
    const snapshotsLen = this.deviceSnapshots.length;
    try {
      return await fn({});
    } catch (err) {
      this.base = baseSnapshot;
      this.zapi = zapiSnapshot;
      this.connectionEvents.length = eventsLen;
      this.deviceSnapshots.length = snapshotsLen;
      throw err;
    }
  }
}

class FakeRedis {
  public zremCalls: Array<{ key: string; member: string }> = [];

  async zrem(key: string, member: string): Promise<number> {
    this.zremCalls.push({ key, member });
    return 1;
  }
}

const connectedSnapshot: SnapshotResult = {
  me: { phone: "5547999998888", name: "Clínica Teste", isBusiness: true },
  device: {
    device: { sessionName: "pixel-8", device_model: "Pixel 8" },
    originalDevice: "PIXEL_8",
    sessionId: 42,
  },
  status: { connected: true, smartphoneConnected: true },
};

interface InstanceViewResp {
  id: string;
  isEnabled: boolean;
  displayName: string;
  redisKey: string;
  updatedAt: string;
  zapi: {
    zapiInstanceId: string;
    instanceTokenMasked: string;
    customClientTokenMasked: string | null;
    currentConnectionState: string | null;
    currentConnected: boolean | null;
    currentPhoneNumber: string | null;
    lastStatusSyncedAt: string | null;
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

interface TestCtx {
  repo: FakeRepository;
  redis: FakeRedis;
  app: ReturnType<typeof buildApp>;
  clientFactory: (creds: ZApiClientCredentials) => ZApiRefreshClient;
  setSnapshot: (result: SnapshotResult | Error) => void;
  capturedCredentials: ZApiClientCredentials[];
}

function buildApp(
  repository: FakeRepository,
  redis: FakeRedis,
  clientFactory: (creds: ZApiClientCredentials) => ZApiRefreshClient
) {
  const service = new MessagingProviderInstanceService({
    // biome-ignore lint/suspicious/noExplicitAny: fake repository compat
    repo: repository as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake redis compat
    redis: redis as any,
    clientFactory,
  });
  return new Elysia().use(providerInstancesModule({ instanceService: service }));
}

function buildCtx(initialSnapshot: SnapshotResult | Error = connectedSnapshot): TestCtx {
  const repo = new FakeRepository();
  const redis = new FakeRedis();
  const capturedCredentials: ZApiClientCredentials[] = [];
  let currentSnapshot: SnapshotResult | Error = initialSnapshot;

  const clientFactory = (creds: ZApiClientCredentials): ZApiRefreshClient => {
    capturedCredentials.push(creds);
    return {
      async refreshSnapshot() {
        if (currentSnapshot instanceof Error) throw currentSnapshot;
        return currentSnapshot;
      },
    };
  };

  return {
    repo,
    redis,
    app: buildApp(repo, redis, clientFactory),
    clientFactory,
    setSnapshot: (s) => {
      currentSnapshot = s;
    },
    capturedCredentials,
  };
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

let ctx: TestCtx;
beforeEach(() => {
  ctx = buildCtx();
});

describe("POST /providers/instances", () => {
  it("401 sem x-api-key", async () => {
    const res = await makeRequest(
      ctx.app,
      "/providers/instances",
      {
        method: "POST",
        body: JSON.stringify({
          displayName: "inst",
          zapiInstanceId: "i1",
          instanceToken: "tokenabcdef",
        }),
      },
      null
    );
    expect(res.status).toBe(401);
  });

  it("201 no happy path com refresh bem-sucedido + redisKey default", async () => {
    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "i1",
        instanceToken: "supersecret1234",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as OkResp;
    expect(body.data.displayName).toBe("inst-01");
    expect(body.data.redisKey).toBe("qp:whatsapp");
    expect(body.data.zapi?.instanceTokenMasked).toBe("supe...1234");
    expect(body.data.zapi?.customClientTokenMasked).toBeNull();
    expect(body.data.zapi?.currentConnected).toBe(true);
    expect(body.data.zapi?.currentConnectionState).toBe("connected");
    expect(body.data.zapi?.currentPhoneNumber).toBe("5547999998888");
    expect(body.data.zapi?.lastStatusSyncedAt).toBeTruthy();
    expect(body.warning).toContain("restart");

    expect(ctx.repo.connectionEvents.length).toBe(1);
    expect(ctx.repo.connectionEvents[0]?.event.source).toBe("bootstrap");
    expect(ctx.repo.deviceSnapshots.length).toBe(1);
    expect(ctx.repo.deviceSnapshots[0]?.snapshot.source).toBe("bootstrap");
  });

  it("usa env.ZAPI_CLIENT_TOKEN quando customClientToken não informado", async () => {
    await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
      }),
    });
    expect(ctx.capturedCredentials[0]?.customClientToken).toBeNull();
  });

  it("persiste e mascara customClientToken quando informado", async () => {
    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
        customClientToken: "customtoken9999",
      }),
    });
    const body = (await res.json()) as OkResp;
    expect(body.data.zapi?.customClientTokenMasked).toBe("cust...9999");
    expect(ctx.capturedCredentials[0]?.customClientToken).toBe("customtoken9999");
  });

  it("502 + rollback quando Z-API falha no refresh do create", async () => {
    ctx.setSnapshot(new Error("instance off"));

    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
      }),
    });
    expect(res.status).toBe(502);

    const list = await makeRequest(ctx.app, "/providers/instances");
    const listBody = (await list.json()) as ListResp;
    expect(listBody.pagination.total).toBe(0);
    expect(ctx.repo.connectionEvents.length).toBe(0);
    expect(ctx.repo.deviceSnapshots.length).toBe(0);
  });

  it("409 quando zapiInstanceId duplicado", async () => {
    await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-01",
        zapiInstanceId: "dup",
        instanceToken: "tokenabcdef",
      }),
    });

    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst-02",
        zapiInstanceId: "dup",
        instanceToken: "other-token-value",
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("zapiInstanceId");
  });

  it("422 quando displayName falta", async () => {
    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("aceita redisKey customizado (não é imutável)", async () => {
    const res = await makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName: "inst",
        zapiInstanceId: "i1",
        instanceToken: "tokenabcdef",
        redisKey: "custom:pool",
      }),
    });
    const body = (await res.json()) as OkResp;
    expect(body.data.redisKey).toBe("custom:pool");
  });
});

async function createOne(ctx: TestCtx, override: Partial<Record<string, unknown>> = {}) {
  const res = await makeRequest(ctx.app, "/providers/instances", {
    method: "POST",
    body: JSON.stringify({
      displayName: "inst-01",
      zapiInstanceId: "i1",
      instanceToken: "supersecret1234",
      ...override,
    }),
  });
  return ((await res.json()) as OkResp).data.id;
}

describe("PATCH /providers/instances/:id", () => {
  it("200 atualiza displayName e dispara refresh", async () => {
    const id = await createOne(ctx);

    const res = await makeRequest(ctx.app, `/providers/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "inst-01-renamed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.displayName).toBe("inst-01-renamed");
    expect(body.warning).toContain("restart");
    expect(ctx.repo.connectionEvents.length).toBe(2); // bootstrap + manual
    expect(ctx.repo.connectionEvents[1]?.event.source).toBe("manual");
  });

  it("502 + rollback quando refresh falha ao editar customClientToken", async () => {
    const id = await createOne(ctx);
    const beforeToken = ctx.repo.zapi.get(id)?.customClientToken ?? null;

    ctx.setSnapshot(new Error("bad token"));

    const res = await makeRequest(ctx.app, `/providers/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ customClientToken: "novo-token-quebrado" }),
    });
    expect(res.status).toBe(502);
    const afterToken = ctx.repo.zapi.get(id)?.customClientToken ?? null;
    expect(afterToken).toBe(beforeToken);
  });

  it("falha no refresh do PATCH não ejeta do pool nem desabilita a instância", async () => {
    const id = await createOne(ctx);

    ctx.setSnapshot(new Error("bad token"));

    const res = await makeRequest(ctx.app, `/providers/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ customClientToken: "novo-token-quebrado" }),
    });
    expect(res.status).toBe(502);

    const after = await makeRequest(ctx.app, `/providers/instances/${id}`);
    const afterBody = (await after.json()) as OkResp;
    expect(afterBody.data.isEnabled).toBe(true);
    expect(afterBody.data.zapi?.currentConnectionState).toBe("connected");
    expect(ctx.redis.zremCalls.length).toBe(0);
  });

  it("ignora zapiInstanceId no body (imutável — campo não existe no schema)", async () => {
    const id = await createOne(ctx);
    const res = await makeRequest(ctx.app, `/providers/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ zapiInstanceId: "outro-id", displayName: "renomeado" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.displayName).toBe("renomeado");
    expect(body.data.zapi?.zapiInstanceId).toBe("i1");
  });

  it("404 quando id não existe", async () => {
    const res = await makeRequest(ctx.app, `/providers/instances/${randomUUID()}`, {
      method: "PATCH",
      body: JSON.stringify({ displayName: "novo" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /providers/instances/:id/refresh", () => {
  it("200 com status atualizado em sucesso", async () => {
    const id = await createOne(ctx);
    const res = await makeRequest(ctx.app, `/providers/instances/${id}/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.zapi?.currentConnected).toBe(true);
    expect(ctx.repo.connectionEvents.length).toBe(2);
    expect(ctx.repo.connectionEvents[1]?.event.source).toBe("manual");
    expect(ctx.repo.deviceSnapshots[1]?.snapshot.source).toBe("manual");
  });

  it("502 + ejeta do pool + isEnabled=false quando refresh falha", async () => {
    const id = await createOne(ctx);

    ctx.setSnapshot(new Error("instance disconnected"));

    const res = await makeRequest(ctx.app, `/providers/instances/${id}/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorResp;
    expect(body.error).toContain("unreachable");

    const after = await makeRequest(ctx.app, `/providers/instances/${id}`);
    const afterBody = (await after.json()) as OkResp;
    expect(afterBody.data.isEnabled).toBe(false);
    expect(afterBody.data.zapi?.currentConnectionState).toBe("unreachable");

    expect(ctx.redis.zremCalls.length).toBe(1);
    expect(ctx.redis.zremCalls[0]?.key).toBe("qp:whatsapp");
    expect(ctx.redis.zremCalls[0]?.member).toBe(id);
  });

  it("404 quando id não existe", async () => {
    const res = await makeRequest(ctx.app, `/providers/instances/${randomUUID()}/refresh`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /providers/instances/:id", () => {
  it("200 retorna instância existente com token mascarado", async () => {
    const id = await createOne(ctx);

    const res = await makeRequest(ctx.app, `/providers/instances/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.id).toBe(id);
    expect(body.data.zapi?.instanceTokenMasked).toBe("supe...1234");
  });

  it("422 se id não é uuid", async () => {
    const res = await makeRequest(ctx.app, "/providers/instances/not-a-uuid");
    expect(res.status).toBe(422);
  });

  it("404 se id não existe", async () => {
    const res = await makeRequest(ctx.app, `/providers/instances/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /providers/instances", () => {
  async function create(displayName: string, zapiInstanceId: string) {
    return makeRequest(ctx.app, "/providers/instances", {
      method: "POST",
      body: JSON.stringify({
        displayName,
        zapiInstanceId,
        instanceToken: "tokenabcdef",
      }),
    });
  }

  it("200 com paginação default", async () => {
    await create("a", "i1");
    await create("b", "i2");

    const res = await makeRequest(ctx.app, "/providers/instances");
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
    await makeRequest(ctx.app, `/providers/instances/${id}/disable`, { method: "PATCH" });

    const res = await makeRequest(ctx.app, "/providers/instances?isEnabled=false");
    const body = (await res.json()) as ListResp;
    expect(body.data.length).toBe(1);
    expect(body.data[0]?.id).toBe(id);
  });

  it("aplica limit e offset", async () => {
    await create("a", "i1");
    await create("b", "i2");
    await create("c", "i3");

    const res = await makeRequest(ctx.app, "/providers/instances?limit=1&offset=1");
    const body = (await res.json()) as ListResp;
    expect(body.data.length).toBe(1);
    expect(body.pagination.total).toBe(3);
  });
});

describe("PATCH /providers/instances/:id/disable e /enable", () => {
  it("disable vira isEnabled=false e altera updatedAt", async () => {
    const id = await createOne(ctx);
    const before = await makeRequest(ctx.app, `/providers/instances/${id}`);
    const beforeBody = (await before.json()) as OkResp;

    const res = await makeRequest(ctx.app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkResp;
    expect(body.data.isEnabled).toBe(false);
    expect(body.warning).toContain("restart");
    expect(body.data.updatedAt).not.toBe(beforeBody.data.updatedAt);
  });

  it("disable é idempotente (segunda chamada não altera updatedAt)", async () => {
    const id = await createOne(ctx);
    const first = await makeRequest(ctx.app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    const firstBody = (await first.json()) as OkResp;

    const second = await makeRequest(ctx.app, `/providers/instances/${id}/disable`, {
      method: "PATCH",
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as OkResp;
    expect(secondBody.data.isEnabled).toBe(false);
    expect(secondBody.data.updatedAt).toBe(firstBody.data.updatedAt);
  });

  it("enable flipa de volta para isEnabled=true", async () => {
    const id = await createOne(ctx);
    await makeRequest(ctx.app, `/providers/instances/${id}/disable`, { method: "PATCH" });
    const res = await makeRequest(ctx.app, `/providers/instances/${id}/enable`, {
      method: "PATCH",
    });
    const body = (await res.json()) as OkResp;
    expect(body.data.isEnabled).toBe(true);
  });

  it("404 para id inexistente", async () => {
    const res = await makeRequest(ctx.app, `/providers/instances/${randomUUID()}/disable`, {
      method: "PATCH",
    });
    expect(res.status).toBe(404);
  });
});
