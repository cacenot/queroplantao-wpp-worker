import { describe, expect, it, mock } from "bun:test";
import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import type { OutboundMessagesRepository } from "../../db/repositories/outbound-messages-repository.ts";
import type { OutboundMessage } from "../../db/schema/outbound-messages.ts";
import type { TaskService } from "../task/index.ts";
import { OutboundMessagesService } from "./outbound-messages-service.ts";
import {
  InvalidPhoneError,
  ProviderInstanceNotActiveError,
  ProviderInstanceNotFoundError,
} from "./types.ts";

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

type ProviderInstanceState = "active" | "not_found" | "not_active";

function makeProviderInstanceRepo(state: ProviderInstanceState = "active") {
  const instance =
    state === "not_found"
      ? null
      : {
          base: {
            id: PROVIDER_INSTANCE_ID,
            protocol: "whatsapp",
            providerKind: "whatsapp_zapi",
            isEnabled: state === "active",
            archivedAt: null,
          },
          zapi: null,
        };

  return {
    findActiveById: mock(() =>
      Promise.resolve(
        state === "not_found"
          ? { kind: "not_found" as const }
          : state === "not_active"
            ? { kind: "not_active" as const, instance }
            : { kind: "active" as const, instance }
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

    // Phone normalizado para E.164 — vai para target_external_id (target_kind=contact).
    const createCall = (outboundMessagesRepo.create as unknown as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as { targetExternalId: string };
    expect(createCall.targetExternalId).toBe("+5547997490248");
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
      messagingGroupId: string | null;
    };
    expect(createCall.targetKind).toBe("group");
    expect(createCall.targetExternalId).toBe("120363111111111111@g.us");
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
      providerInstanceRepo: makeProviderInstanceRepo("not_found"),
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

  it("provider instance inativa: lança ProviderInstanceNotActiveError", async () => {
    const outboundMessagesRepo = makeOutboundRepo();
    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(),
      providerInstanceRepo: makeProviderInstanceRepo("not_active"),
      taskService: makeTaskService(),
    });

    await expect(
      service.send({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        target: { kind: "contact", phone: "+5547997490248" },
        content: { kind: "text", message: "olá" },
      })
    ).rejects.toBeInstanceOf(ProviderInstanceNotActiveError);

    expect(outboundMessagesRepo.create).toHaveBeenCalledTimes(0);
  });

  it("race em idempotency_key: 23505 no INSERT vira deduplicated via refetch", async () => {
    // Cenário: dois callers concorrentes com a mesma idempotencyKey. Ambos
    // passam pelo findByIdempotencyKey vendo `null`, ambos chegam no INSERT,
    // o segundo bate no índice único parcial.
    const existing = {
      id: "existing-id",
      taskId: "existing-task",
    } as unknown as OutboundMessage;
    let firstFindCall = true;
    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });

    const outboundMessagesRepo = makeOutboundRepo({
      findByIdempotencyKey: mock(() => {
        // Primeira chamada (antes do INSERT) → null. Segunda (recovery) → row.
        if (firstFindCall) {
          firstFindCall = false;
          return Promise.resolve(null);
        }
        return Promise.resolve(existing);
      }) as unknown as OutboundMessagesRepository["findByIdempotencyKey"],
      create: mock(() =>
        Promise.reject(uniqueViolation)
      ) as unknown as OutboundMessagesRepository["create"],
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
      idempotencyKey: "race-key",
    });

    expect(outcome).toEqual({
      outboundMessageId: "existing-id",
      taskId: "existing-task",
      status: "deduplicated",
    });
    expect(taskService.enqueue).toHaveBeenCalledTimes(0);
  });

  it("erro genérico no INSERT (não-23505) propaga", async () => {
    const dbErr = Object.assign(new Error("connection lost"), { code: "08006" });
    const outboundMessagesRepo = makeOutboundRepo({
      create: mock(() => Promise.reject(dbErr)) as unknown as OutboundMessagesRepository["create"],
    });

    const service = new OutboundMessagesService({
      outboundMessagesRepo,
      messagingGroupsRepo: makeMessagingGroupsRepo(),
      providerInstanceRepo: makeProviderInstanceRepo(),
      taskService: makeTaskService(),
    });

    await expect(
      service.send({
        providerInstanceId: PROVIDER_INSTANCE_ID,
        target: { kind: "contact", phone: "+5547997490248" },
        content: { kind: "text", message: "olá" },
        idempotencyKey: "key-x",
      })
    ).rejects.toBe(dbErr);
  });
});
