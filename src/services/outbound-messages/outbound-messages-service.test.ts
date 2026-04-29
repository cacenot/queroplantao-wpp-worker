import { describe, expect, it, mock } from "bun:test";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { OutboundMessage } from "../../db/schema/outbound-messages.ts";
import type { TaskService } from "../task/index.ts";
import { OutboundMessagesService } from "./outbound-messages-service.ts";
import { InvalidPhoneError, ProviderInstanceNotFoundError } from "./types.ts";

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";
const OUTBOUND_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_INTERNAL_ID = "33333333-3333-3333-3333-333333333333";

function makeOutboundRepo(overrides: Partial<OutboundMessagesRepository> = {}) {
  return {
    create: mock((row: { idempotencyKey?: string }) =>
      Promise.resolve({
        id: OUTBOUND_ID,
        ...row,
      } as unknown as OutboundMessage)
    ),
    findByIdempotencyKey: mock(() => Promise.resolve(null)),
    setTaskId: mock(() => Promise.resolve()),
    markSending: mock(() => Promise.resolve()),
    markSent: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as OutboundMessagesRepository;
}

function makeMessagingGroupsRepo(group: { id: string } | null = null) {
  return {
    findByExternalId: mock(() => Promise.resolve(group)),
  } as unknown as MessagingGroupsRepository;
}

function makeProviderInstanceRepo(found = true) {
  return {
    findById: mock(() =>
      Promise.resolve(
        found
          ? {
              base: {
                id: PROVIDER_INSTANCE_ID,
                protocol: "whatsapp",
                providerKind: "whatsapp_zapi",
              },
              zapi: null,
            }
          : null
      )
    ),
  } as unknown as MessagingProviderInstanceRepository;
}

function makeTaskService() {
  return {
    enqueue: mock(() => Promise.resolve({ accepted: 1, duplicates: 0, ids: [] })),
  } as unknown as TaskService;
}

describe("OutboundMessagesService.send — happy path", () => {
  it("contato: cria row, enfileira job e seta taskId", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const messagingGroupsRepo = makeMessagingGroupsRepo();
    const providerInstanceRepo = makeProviderInstanceRepo();
    const taskService = makeTaskService();

    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo,
      providerInstanceRepo,
      taskService,
    });

    const outcome = await service.send({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      target: { kind: "contact", phone: "5547997490248" },
      content: { kind: "text", message: "olá" },
    });

    expect(outcome.outboundMessageId).toBe(OUTBOUND_ID);
    expect(outcome.status).toBe("queued");
    expect(outcome.taskId).not.toBeNull();
    expect(outboundMessagesRepo.create).toHaveBeenCalledTimes(1);
    expect(taskService.enqueue).toHaveBeenCalledTimes(1);
    expect(outboundMessagesRepo.setTaskId).toHaveBeenCalledTimes(1);

    // Phone normalizado para E.164 e replicado no targetPhoneE164
    const createCall = (outboundMessagesRepo.create as unknown as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as { targetExternalId: string; targetPhoneE164: string | null };
    expect(createCall.targetExternalId).toBe("+5547997490248");
    expect(createCall.targetPhoneE164).toBe("+5547997490248");
  });

  it("grupo: resolve messagingGroupId quando o grupo está cadastrado", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const messagingGroupsRepo = makeMessagingGroupsRepo({ id: GROUP_INTERNAL_ID });
    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo,
      providerInstanceRepo: makeProviderInstanceRepo(),
      taskService: makeTaskService(),
    });

    await service.send({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      target: { kind: "group", externalId: "120363111111111111@g.us" },
      content: { kind: "text", message: "oi grupo" },
    });

    const createCall = (outboundMessagesRepo.create as unknown as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as {
      targetKind: string;
      targetExternalId: string;
      targetPhoneE164: string | null;
      messagingGroupId: string | null;
    };
    expect(createCall.targetKind).toBe("group");
    expect(createCall.targetExternalId).toBe("120363111111111111@g.us");
    expect(createCall.targetPhoneE164).toBeNull();
    expect(createCall.messagingGroupId).toBe(GROUP_INTERNAL_ID);
  });

  it("grupo não cadastrado: messagingGroupId fica null e segue", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(null),
      providerInstanceRepo: makeProviderInstanceRepo(),
      taskService: makeTaskService(),
    });

    await service.send({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      target: { kind: "group", externalId: "120363999@g.us" },
      content: { kind: "text", message: "oi" },
    });

    const createCall = (outboundMessagesRepo.create as unknown as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as { messagingGroupId: string | null };
    expect(createCall.messagingGroupId).toBeNull();
  });
});

describe("OutboundMessagesService.send — idempotência", () => {
  it("idempotencyKey existente: retorna a row original sem enfileirar", async () => {
    const existing = {
      id: "existing-id",
      taskId: "existing-task",
    } as unknown as OutboundMessage;

    const outboundMessagesRepo = makeOutboundRepo({
      findByIdempotencyKey: mock(() =>
        Promise.resolve(existing)
      ) as unknown as OutboundMessagesRepository["findByIdempotencyKey"],
    });
    const taskService = makeTaskService();

    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(),
      providerInstanceRepo: makeProviderInstanceRepo(),
      taskService,
    });

    const outcome = await service.send({
      providerInstanceId: PROVIDER_INSTANCE_ID,
      target: { kind: "contact", phone: "+5547997490248" },
      content: { kind: "text", message: "olá" },
      idempotencyKey: "key-1",
    });

    expect(outcome).toEqual({
      outboundMessageId: "existing-id",
      taskId: "existing-task",
      status: "deduplicated",
    });
    expect(outboundMessagesRepo.create).toHaveBeenCalledTimes(0);
    expect(taskService.enqueue).toHaveBeenCalledTimes(0);
  });
});

describe("OutboundMessagesService.send — erros", () => {
  it("phone E.164 inválido: lança InvalidPhoneError sem inserir", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(),
      providerInstanceRepo: makeProviderInstanceRepo(),
      taskService: makeTaskService(),
    });

    await expect(
      service.send({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        target: { kind: "contact", phone: "abc123" },
        content: { kind: "text", message: "olá" },
      })
    ).rejects.toBeInstanceOf(InvalidPhoneError);

    expect(outboundMessagesRepo.create).toHaveBeenCalledTimes(0);
  });

  it("provider instance não encontrada: lança ProviderInstanceNotFoundError", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(),
      providerInstanceRepo: makeProviderInstanceRepo(false),
      taskService: makeTaskService(),
    });

    await expect(
      service.send({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        target: { kind: "contact", phone: "+5547997490248" },
        content: { kind: "text", message: "olá" },
      })
    ).rejects.toBeInstanceOf(ProviderInstanceNotFoundError);

    expect(outboundMessagesRepo.create).toHaveBeenCalledTimes(0);
  });
});
