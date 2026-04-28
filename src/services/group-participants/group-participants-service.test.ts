import { describe, expect, it, mock } from "bun:test";
import type { GroupParticipantsRepository } from "../../db/repositories/group-participants-repository.ts";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { ZapiReceivedWebhookPayload } from "../../gateways/whatsapp/zapi/webhook-schema.ts";
import type { MessagingProviderInstanceService } from "../messaging-provider-instance/index.ts";
import type { TaskService } from "../task/index.ts";
import { GroupParticipantsService } from "./group-participants-service.ts";

const GROUP_ID = "120363000000000042@g.us";
const PROVIDER_INSTANCE = "11111111-1111-1111-1111-111111111111";

function participantEventPayload(
  overrides: Partial<ZapiReceivedWebhookPayload> = {}
): ZapiReceivedWebhookPayload {
  return {
    instanceId: "zapi-inst-1",
    messageId: "webhook-msg-1",
    phone: GROUP_ID,
    isGroup: true,
    isNewsletter: false,
    broadcast: false,
    type: "ReceivedCallback",
    notification: "GROUP_PARTICIPANT_ADD",
    notificationParameters: ["5511999990010"],
    participantPhone: "5511999990001",
    participantLid: "5511999990001@lid",
    senderName: "Admin",
    momment: 1_700_000_000_000,
    ...overrides,
  };
}

function nonNotificationPayload(): ZapiReceivedWebhookPayload {
  // Mensagem normal: sem `notification`. `ingestZapiWebhook` deve retornar ignored.
  return {
    instanceId: "zapi-inst-1",
    messageId: "webhook-msg-2",
    phone: GROUP_ID,
    isGroup: true,
    isNewsletter: false,
    broadcast: false,
    type: "ReceivedCallback",
    momment: 1_700_000_000_000,
    text: { message: "hello" },
  };
}

type Build = {
  taskService?: Partial<TaskService>;
  instanceService?: Partial<MessagingProviderInstanceService>;
  repo?: Partial<GroupParticipantsRepository>;
  messagingGroupsRepo?: Partial<MessagingGroupsRepository>;
};

function build(deps: Build = {}) {
  return new GroupParticipantsService({
    repo: (deps.repo ?? {}) as unknown as GroupParticipantsRepository,
    messagingGroupsRepo: {
      findByExternalId: mock(() => Promise.resolve(null)),
      ...deps.messagingGroupsRepo,
    } as unknown as MessagingGroupsRepository,
    taskService: {
      enqueue: mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: ["job-1"] })),
      ...deps.taskService,
    } as unknown as TaskService,
    instanceService: {
      resolveProviderInstanceIdByZapiInstanceId: mock(() => Promise.resolve(PROVIDER_INSTANCE)),
      ...deps.instanceService,
    } as unknown as MessagingProviderInstanceService,
  });
}

describe("GroupParticipantsService.ingestZapiWebhook", () => {
  describe("payload não é evento de participante", () => {
    it("retorna ignored com reason='no-notification' e não enfileira", async () => {
      const enqueue = mock(() =>
        Promise.resolve({ accepted: 0, duplicates: 0, ids: [] as string[] })
      );
      const svc = build({ taskService: { enqueue } });

      const result = await svc.ingestZapiWebhook(nonNotificationPayload());

      expect(result).toEqual({
        status: "ignored",
        reason: "no-notification",
        notification: undefined,
      });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe("payload é evento válido", () => {
    it("enfileira job com shape correto (occurredAt ISO, providerInstanceId resolvido)", async () => {
      const enqueue = mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: ["job-1"] }));
      const resolve = mock(() => Promise.resolve(PROVIDER_INSTANCE));
      const svc = build({
        taskService: { enqueue },
        instanceService: { resolveProviderInstanceIdByZapiInstanceId: resolve },
      });

      const result = await svc.ingestZapiWebhook(participantEventPayload());

      expect(result).toEqual({ status: "accepted", eventType: "joined_add" });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledTimes(1);

      const enqueuedArgs = (enqueue.mock.calls as unknown as unknown[][])[0]?.[0] as Array<{
        type: string;
        payload: {
          providerInstanceId: string | null;
          event: {
            eventType: string;
            occurredAt: string;
            sourceWebhookMessageId: string;
            sourceNotification: string;
            targets: Array<{ phone: string | null }>;
          };
        };
      }>;
      expect(enqueuedArgs).toHaveLength(1);
      const job = enqueuedArgs[0];
      expect(job?.type).toBe("whatsapp.ingest_participant_event");
      expect(job?.payload.providerInstanceId).toBe(PROVIDER_INSTANCE);
      expect(job?.payload.event.eventType).toBe("joined_add");
      expect(job?.payload.event.sourceNotification).toBe("GROUP_PARTICIPANT_ADD");
      expect(job?.payload.event.sourceWebhookMessageId).toBe("webhook-msg-1");
      expect(job?.payload.event.targets[0]?.phone).toBe("+5511999990010");
      // occurredAt deve ter sido serializado como ISO-8601
      expect(job?.payload.event.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(() => new Date(job?.payload.event.occurredAt ?? "").toISOString()).not.toThrow();
    });

    it("instanceService falhando → providerInstanceId=null, ainda enfileira", async () => {
      const enqueue = mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: ["job-1"] }));
      const resolve = mock(() => Promise.reject(new Error("instance lookup down")));
      const svc = build({
        taskService: { enqueue },
        instanceService: { resolveProviderInstanceIdByZapiInstanceId: resolve },
      });

      const result = await svc.ingestZapiWebhook(participantEventPayload());

      expect(result.status).toBe("accepted");
      expect(enqueue).toHaveBeenCalledTimes(1);
      const enqueuedArgs = (enqueue.mock.calls as unknown as unknown[][])[0]?.[0] as Array<{
        payload: { providerInstanceId: string | null };
      }>;
      expect(enqueuedArgs[0]?.payload.providerInstanceId).toBeNull();
    });

    it("payload sem instanceId → providerInstanceId=null sem chamar instanceService", async () => {
      const enqueue = mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: ["job-1"] }));
      const resolve = mock(() => Promise.resolve(PROVIDER_INSTANCE));
      const svc = build({
        taskService: { enqueue },
        instanceService: { resolveProviderInstanceIdByZapiInstanceId: resolve },
      });

      const result = await svc.ingestZapiWebhook(
        participantEventPayload({ instanceId: undefined })
      );

      expect(result.status).toBe("accepted");
      expect(resolve).not.toHaveBeenCalled();
      const enqueuedArgs = (enqueue.mock.calls as unknown as unknown[][])[0]?.[0] as Array<{
        payload: { providerInstanceId: string | null };
      }>;
      expect(enqueuedArgs[0]?.payload.providerInstanceId).toBeNull();
    });

    it("taskService.enqueue falhando → retorna accepted mesmo assim (não propaga)", async () => {
      const enqueue = mock(() => Promise.reject(new Error("amqp down")));
      const svc = build({ taskService: { enqueue } });

      const result = await svc.ingestZapiWebhook(participantEventPayload());

      expect(result).toEqual({ status: "accepted", eventType: "joined_add" });
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("configuração incompleta", () => {
    it("throw quando taskService não foi injetado", async () => {
      const svc = new GroupParticipantsService({
        repo: {} as unknown as GroupParticipantsRepository,
        messagingGroupsRepo: {} as unknown as MessagingGroupsRepository,
      });

      await expect(svc.ingestZapiWebhook(participantEventPayload())).rejects.toThrow(/taskService/);
    });
  });
});

describe("GroupParticipantsService.applySnapshot", () => {
  type RepoRow = {
    id: string;
    phone: string | null;
    senderExternalId: string | null;
    waId: string | null;
    role: "member" | "admin" | "owner";
    status: "active" | "left";
    messagingGroupId: string | null;
  };

  function makeRepo(initial: RepoRow[] = []): {
    repo: GroupParticipantsRepository;
    rows: RepoRow[];
  } {
    const rows: RepoRow[] = [...initial];
    let nextId = 100;

    const findByIdentifier = mock(
      async (
        _group: string,
        _proto: string,
        identifier: { phone: string | null; senderExternalId: string | null }
      ) => {
        if (identifier.senderExternalId) {
          const r = rows.find((x) => x.senderExternalId === identifier.senderExternalId);
          if (r) return r;
        }
        if (identifier.phone) {
          const r = rows.find((x) => x.phone === identifier.phone);
          if (r) return r;
        }
        return null;
      }
    );

    const insert = mock(async (row: Partial<RepoRow>) => {
      const id = `new-${nextId++}`;
      const inserted: RepoRow = {
        id,
        phone: row.phone ?? null,
        senderExternalId: row.senderExternalId ?? null,
        waId: row.waId ?? null,
        role: row.role ?? "member",
        status: row.status ?? "active",
        messagingGroupId: row.messagingGroupId ?? null,
      };
      rows.push(inserted);
      return inserted;
    });

    const update = mock(async (id: string, patch: Partial<RepoRow>) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`row ${id} not found`);
      Object.assign(r, patch);
      return r;
    });

    const findActiveByGroup = mock(async (_group: string, _proto: string) =>
      rows.filter((r) => r.status === "active")
    );

    const hasOtherRowWithIdentifier = mock(async () => false);

    return {
      rows,
      repo: {
        findByIdentifier,
        insert,
        update,
        findActiveByGroup,
        hasOtherRowWithIdentifier,
      } as unknown as GroupParticipantsRepository,
    };
  }

  it("insere novos participantes com role correto", async () => {
    const { repo, rows } = makeRepo();
    const svc = new GroupParticipantsService({
      repo,
      messagingGroupsRepo: {
        findByExternalId: mock(() => Promise.resolve({ id: "mg-1" })),
      } as unknown as MessagingGroupsRepository,
    });

    const outcome = await svc.applySnapshot({
      providerInstanceId: PROVIDER_INSTANCE,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      observedAt: new Date(),
      markMissingAsLeft: false,
      participants: [
        {
          phone: "+5511999990001",
          senderExternalId: null,
          waId: "5511999990001@s.whatsapp.net",
          role: "admin",
        },
        {
          phone: "+5511999990002",
          senderExternalId: null,
          waId: "5511999990002@s.whatsapp.net",
          role: "member",
        },
      ],
    });

    expect(outcome.upserted).toBe(2);
    expect(outcome.markedAsLeft).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.role).toBe("admin");
    expect(rows[0]?.waId).toBe("5511999990001@s.whatsapp.net");
    expect(rows[0]?.messagingGroupId).toBe("mg-1");
  });

  it("atualiza role e preenche waId em participantes existentes", async () => {
    const { repo, rows } = makeRepo([
      {
        id: "existing-1",
        phone: "+5511999990001",
        senderExternalId: null,
        waId: null,
        role: "member",
        status: "active",
        messagingGroupId: null,
      },
    ]);
    const svc = new GroupParticipantsService({
      repo,
      messagingGroupsRepo: {
        findByExternalId: mock(() => Promise.resolve(null)),
      } as unknown as MessagingGroupsRepository,
    });

    await svc.applySnapshot({
      providerInstanceId: PROVIDER_INSTANCE,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      observedAt: new Date(),
      markMissingAsLeft: false,
      participants: [
        {
          phone: "+5511999990001",
          senderExternalId: null,
          waId: "5511999990001@s.whatsapp.net",
          role: "admin",
        },
      ],
    });

    expect(rows[0]?.role).toBe("admin");
    expect(rows[0]?.waId).toBe("5511999990001@s.whatsapp.net");
    expect(rows[0]?.status).toBe("active");
  });

  it("preserva owner existente quando snapshot diz que é admin", async () => {
    const { repo, rows } = makeRepo([
      {
        id: "owner-1",
        phone: "+5511999990001",
        senderExternalId: null,
        waId: null,
        role: "owner",
        status: "active",
        messagingGroupId: null,
      },
    ]);
    const svc = new GroupParticipantsService({
      repo,
      messagingGroupsRepo: {
        findByExternalId: mock(() => Promise.resolve(null)),
      } as unknown as MessagingGroupsRepository,
    });

    await svc.applySnapshot({
      providerInstanceId: PROVIDER_INSTANCE,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      observedAt: new Date(),
      markMissingAsLeft: false,
      participants: [
        {
          phone: "+5511999990001",
          senderExternalId: null,
          waId: null,
          role: "admin",
        },
      ],
    });

    expect(rows[0]?.role).toBe("owner");
  });

  it("markMissingAsLeft marca participantes ativos ausentes do snapshot", async () => {
    const { repo, rows } = makeRepo([
      {
        id: "still-1",
        phone: "+5511999990001",
        senderExternalId: null,
        waId: null,
        role: "member",
        status: "active",
        messagingGroupId: null,
      },
      {
        id: "gone-1",
        phone: "+5511999990099",
        senderExternalId: null,
        waId: null,
        role: "member",
        status: "active",
        messagingGroupId: null,
      },
    ]);
    const svc = new GroupParticipantsService({
      repo,
      messagingGroupsRepo: {
        findByExternalId: mock(() => Promise.resolve(null)),
      } as unknown as MessagingGroupsRepository,
    });

    const outcome = await svc.applySnapshot({
      providerInstanceId: PROVIDER_INSTANCE,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      observedAt: new Date(),
      markMissingAsLeft: true,
      participants: [
        {
          phone: "+5511999990001",
          senderExternalId: null,
          waId: null,
          role: "member",
        },
      ],
    });

    expect(outcome.markedAsLeft).toBe(1);
    const gone = rows.find((r) => r.id === "gone-1");
    expect(gone?.status).toBe("left");
    const still = rows.find((r) => r.id === "still-1");
    expect(still?.status).toBe("active");
  });

  it("markMissingAsLeft=false não toca participantes ausentes", async () => {
    const { repo, rows } = makeRepo([
      {
        id: "gone-1",
        phone: "+5511999990099",
        senderExternalId: null,
        waId: null,
        role: "member",
        status: "active",
        messagingGroupId: null,
      },
    ]);
    const svc = new GroupParticipantsService({
      repo,
      messagingGroupsRepo: {
        findByExternalId: mock(() => Promise.resolve(null)),
      } as unknown as MessagingGroupsRepository,
    });

    const outcome = await svc.applySnapshot({
      providerInstanceId: PROVIDER_INSTANCE,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: GROUP_ID,
      observedAt: new Date(),
      markMissingAsLeft: false,
      participants: [],
    });

    expect(outcome.markedAsLeft).toBe(0);
    expect(rows[0]?.status).toBe("active");
  });
});
