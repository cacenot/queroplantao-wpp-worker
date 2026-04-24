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
