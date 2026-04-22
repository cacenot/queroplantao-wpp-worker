import { describe, expect, it, mock } from "bun:test";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../../db/repositories/message-moderations-repository.ts";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { GroupMessage } from "../../db/schema/group-messages.ts";
import type { MessageModeration } from "../../db/schema/message-moderations.ts";
import type { NormalizedZapiMessage } from "../../gateways/whatsapp/zapi/message-normalizer.ts";
import type { MessagingGroupsCache } from "../messaging-groups/messaging-groups-cache.ts";
import type { ModerationEnforcementService } from "../moderation-enforcement/index.ts";
import type { TaskService } from "../task/index.ts";
import { GroupMessagesService } from "./group-messages-service.ts";

const MSG_ID = "00000000-0000-0000-0000-000000000001";
const MOD_ID = "00000000-0000-0000-0000-000000000002";

function makeNormalized(overrides: Partial<NormalizedZapiMessage> = {}): NormalizedZapiMessage {
  return {
    providerKind: "whatsapp_zapi",
    protocol: "whatsapp",
    groupExternalId: "120363000000000000@g.us",
    senderPhone: "+5511999990001",
    senderExternalId: null,
    senderName: "Alice",
    externalMessageId: "msg-ext-1",
    referenceExternalMessageId: null,
    messageType: "text",
    messageSubtype: null,
    hasText: true,
    normalizedText: "plantão disponível",
    mediaUrl: null,
    thumbnailUrl: null,
    mimeType: null,
    caption: null,
    sentAt: new Date("2026-04-01T12:00:00Z"),
    fromMe: false,
    isForwarded: false,
    isEdited: false,
    zapi: {
      instanceExternalId: "instance-1",
      connectedPhone: null,
      chatName: "Grupo Teste",
      status: null,
      senderLid: null,
      waitingMessage: null,
      viewOnce: null,
      extractedPayload: null,
      rawPayload: {} as never,
    },
    ...overrides,
  };
}

function makeMessageRow(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    id: MSG_ID,
    ingestionDedupeHash: "dedupe-hash",
    contentHash: "content-hash",
    protocol: "whatsapp",
    providerKind: "whatsapp_zapi",
    providerInstanceId: null,
    groupExternalId: "120363000000000000@g.us",
    messagingGroupId: null,
    senderPhone: "+5511999990001",
    senderExternalId: null,
    senderName: "Alice",
    externalMessageId: "msg-ext-1",
    referenceExternalMessageId: null,
    messageType: "text",
    messageSubtype: null,
    hasText: true,
    normalizedText: "plantão disponível",
    mediaUrl: null,
    thumbnailUrl: null,
    mimeType: null,
    caption: null,
    sentAt: new Date("2026-04-01T12:00:00Z"),
    fromMe: false,
    isForwarded: false,
    isEdited: false,
    moderationStatus: "pending",
    currentModerationId: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeModeration(overrides: Partial<MessageModeration> = {}): MessageModeration {
  return {
    id: MOD_ID,
    groupMessageId: MSG_ID,
    contentHash: "content-hash",
    moderationVersion: "v1",
    model: "openai/gpt-4o-mini",
    source: "fresh",
    sourceModerationId: null,
    status: "pending",
    reason: null,
    partner: null,
    category: null,
    confidence: null,
    action: null,
    rawResult: null,
    promptTokens: null,
    completionTokens: null,
    latencyMs: null,
    error: null,
    createdAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

type Deps = {
  groupMessagesRepo?: Partial<GroupMessagesRepository>;
  moderationsRepo?: Partial<MessageModerationsRepository>;
  messagingGroupsRepo?: Partial<MessagingGroupsRepository>;
  messagingGroupsCache?: Partial<MessagingGroupsCache>;
  taskService?: Partial<TaskService>;
  moderationConfig?: { version: string; primaryModel: string };
  enforcement?: Partial<ModerationEnforcementService>;
};

function makeService(deps: Deps = {}) {
  return new GroupMessagesService({
    groupMessagesRepo: {
      upsertByIngestionHash: mock(() => Promise.resolve({ row: makeMessageRow(), isNew: true })),
      setCurrentModeration: mock(() => Promise.resolve()),
      setModerationStatus: mock(() => Promise.resolve()),
      ...deps.groupMessagesRepo,
    } as unknown as GroupMessagesRepository,

    moderationsRepo: {
      create: mock(() => Promise.resolve(makeModeration())),
      findReusable: mock(() => Promise.resolve(null)),
      ...deps.moderationsRepo,
    } as unknown as MessageModerationsRepository,

    messagingGroupsRepo: {
      findByExternalId: mock(() => Promise.resolve(null)),
      ...deps.messagingGroupsRepo,
    } as unknown as MessagingGroupsRepository,

    messagingGroupsCache: {
      isMonitored: mock(() => Promise.resolve(true)),
      ...deps.messagingGroupsCache,
    } as unknown as MessagingGroupsCache,

    taskService: {
      enqueue: mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: [MOD_ID] })),
      ...deps.taskService,
    } as unknown as TaskService,

    moderationConfig: deps.moderationConfig ?? {
      version: "v1",
      primaryModel: "openai/gpt-4o-mini",
    },

    enforcement: {
      evaluateAndEnforce: mock(() => Promise.resolve()),
      ...deps.enforcement,
    } as unknown as ModerationEnforcementService,

    ingestionDedupeWindowMs: 60_000,
    moderationReuseWindowMs: 86_400_000,
  });
}

const CTX = { providerInstanceId: null };

describe("GroupMessagesService.ingestZapi", () => {
  describe("grupo não monitorado", () => {
    it("retorna ignored sem tocar repos", async () => {
      const svc = makeService({
        messagingGroupsCache: { isMonitored: mock(() => Promise.resolve(false)) },
      });

      const result = await svc.ingestZapi(makeNormalized(), CTX);
      expect(result).toEqual({ status: "ignored", reason: "group-not-monitored" });
    });
  });

  describe("mensagem duplicada", () => {
    it("retorna duplicate quando upsert indica isNew=false", async () => {
      const svc = makeService({
        groupMessagesRepo: {
          upsertByIngestionHash: mock(() =>
            Promise.resolve({ row: makeMessageRow(), isNew: false })
          ),
          setCurrentModeration: mock(() => Promise.resolve()),
        },
      });

      const result = await svc.ingestZapi(makeNormalized(), CTX);
      expect(result).toEqual({ status: "duplicate", messageId: MSG_ID });
    });
  });

  describe("fluxo normal", () => {
    it("enfileira job e retorna queued", async () => {
      const taskEnqueue = mock(() =>
        Promise.resolve({ accepted: 1, duplicates: 0, ids: [MOD_ID] })
      );
      const createMod = mock(() =>
        Promise.resolve(makeModeration({ id: MOD_ID, source: "fresh", status: "pending" }))
      );

      const svc = makeService({
        moderationsRepo: { create: createMod, findReusable: mock(() => Promise.resolve(null)) },
        taskService: { enqueue: taskEnqueue },
      });

      const result = await svc.ingestZapi(makeNormalized(), CTX);

      expect(result).toEqual({ status: "queued", messageId: MSG_ID, moderationId: MOD_ID });
      expect(taskEnqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("caminho cached", () => {
    it("dispara enforcement.evaluateAndEnforce com dados do normalized", async () => {
      const cachedSource = makeModeration({
        id: "00000000-0000-0000-0000-0000000000aa",
        source: "fresh",
        status: "analyzed",
      });
      const reusedRow = makeModeration({
        id: "00000000-0000-0000-0000-0000000000bb",
        source: "cached",
        status: "analyzed",
      });

      const evaluateAndEnforce = mock(() => Promise.resolve());
      const ctx = { providerInstanceId: "00000000-0000-0000-0000-000000000099" };

      const svc = makeService({
        moderationsRepo: {
          findReusable: mock(() => Promise.resolve(cachedSource)),
          create: mock(() => Promise.resolve(reusedRow)),
        },
        enforcement: { evaluateAndEnforce },
      });

      const normalized = makeNormalized({
        senderExternalId: "1234567890@lid",
        externalMessageId: "msg-cached-1",
      });
      const result = await svc.ingestZapi(normalized, ctx);

      expect(result.status).toBe("reused");
      expect(evaluateAndEnforce).toHaveBeenCalledTimes(1);
      const evalArgs = (evaluateAndEnforce.mock.calls as unknown as unknown[][])[0]?.[0];
      expect(evalArgs).toEqual({
        protocol: "whatsapp",
        groupExternalId: "120363000000000000@g.us",
        senderPhone: "+5511999990001",
        senderExternalId: "1234567890@lid",
        providerInstanceId: ctx.providerInstanceId,
        externalMessageId: "msg-cached-1",
        moderationId: reusedRow.id,
        groupMessageId: MSG_ID,
      });
    });

    it("falha do enforcement não derruba ingest cached", async () => {
      const cachedSource = makeModeration({ id: "src-1", status: "analyzed" });
      const reusedRow = makeModeration({ id: "reused-1", source: "cached", status: "analyzed" });

      const svc = makeService({
        moderationsRepo: {
          findReusable: mock(() => Promise.resolve(cachedSource)),
          create: mock(() => Promise.resolve(reusedRow)),
        },
        enforcement: { evaluateAndEnforce: mock(() => Promise.reject(new Error("redis down"))) },
      });

      const result = await svc.ingestZapi(makeNormalized(), CTX);
      expect(result.status).toBe("reused");
    });
  });
});
