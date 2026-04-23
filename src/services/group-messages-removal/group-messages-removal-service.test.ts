import { describe, expect, it, mock } from "bun:test";
import type { Db } from "../../db/client.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import {
  type PhonePoliciesService,
  ConflictError as PhonePolicyConflictError,
} from "../phone-policies/index.ts";
import type { TaskService } from "../task/index.ts";
import { GroupMessagesRemovalService } from "./group-messages-removal-service.ts";
import {
  AllowlistConflictError,
  InvalidPhoneError,
  NoFiltersError,
  PhoneFilterTooShortError,
} from "./types.ts";

type RawRow = {
  group_message_id: string;
  external_message_id: string;
  group_external_id: string;
  sender_phone: string | null;
  sender_external_id: string | null;
  content_hash: string;
  provider_instance_id: string;
  protocol: "whatsapp";
  allowlist_policy_id: string | null;
};

function makeRawRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    group_message_id: "11111111-1111-1111-1111-111111111111",
    external_message_id: "msg-1",
    group_external_id: "120363000000000001@g.us",
    sender_phone: "+5511999990001",
    sender_external_id: null,
    content_hash: "hash-1",
    provider_instance_id: "22222222-2222-2222-2222-222222222222",
    protocol: "whatsapp",
    allowlist_policy_id: null,
    ...overrides,
  };
}

function makeDb(responses: unknown[][]): { db: Db; execute: ReturnType<typeof mock> } {
  const queue = [...responses];
  const execute = mock(() => Promise.resolve(queue.shift() ?? []));
  const db = { execute } as unknown as Db;
  return { db, execute };
}

function makePhonePoliciesService(
  overrides: Partial<PhonePoliciesService> = {}
): PhonePoliciesService {
  return {
    add: mock(async (input) => ({
      id: "policy-new",
      protocol: input.protocol,
      kind: input.kind,
      phone: input.phone ?? null,
      senderExternalId: input.senderExternalId ?? null,
      groupExternalId: input.groupExternalId ?? null,
      source: input.source ?? "manual",
      reason: input.reason ?? null,
      notes: null,
      moderationId: null,
      metadata: {},
      expiresAt: null,
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    })),
    ...overrides,
  } as unknown as PhonePoliciesService;
}

function makeTaskService(overrides: Partial<TaskService> = {}): {
  service: TaskService;
  enqueue: ReturnType<typeof mock>;
} {
  const enqueue = mock(async () => ({ accepted: 0, duplicates: 0, ids: [] }));
  const service = {
    enqueue,
    ...overrides,
  } as unknown as TaskService;
  return { service, enqueue };
}

// ─── Input validation ─────────────────────────────────────────────────────────

describe("GroupMessagesRemovalService — validação de input", () => {
  it("previewByPhone rejeita phone com menos de 10 dígitos", async () => {
    const { db } = makeDb([]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    await expect(svc.previewByPhone({ phone: "123456789" })).rejects.toBeInstanceOf(
      PhoneFilterTooShortError
    );
  });

  it("previewByPhone rejeita phone que não parseia como E.164", async () => {
    const { db } = makeDb([]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    // 10 dígitos, mas phone inválido
    await expect(svc.previewByPhone({ phone: "0000000000" })).rejects.toBeInstanceOf(
      InvalidPhoneError
    );
  });

  it("previewBySpam rejeita quando filters vazio", async () => {
    const { db } = makeDb([]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    await expect(svc.previewBySpam({ filters: [] })).rejects.toBeInstanceOf(NoFiltersError);
  });
});

// ─── previewByPhone ──────────────────────────────────────────────────────────

describe("GroupMessagesRemovalService.previewByPhone", () => {
  it("retorna allowlistConflict quando phone está em allowlist", async () => {
    const { db } = makeDb([
      [
        {
          id: "policy-1",
          phone: "+5511999990001",
          sender_external_id: null,
          group_external_id: null,
          reason: "paciente VIP",
        },
      ],
    ]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    const preview = await svc.previewByPhone({ phone: "5511999990001" });
    expect(preview.allowlistConflict?.policyId).toBe("policy-1");
    expect(preview.messageCount).toBe(0);
  });

  it("agrega counts por grupo e sender únicos", async () => {
    const { db } = makeDb([
      [], // allowlist (vazio)
      [], // blacklist (não existe)
      [
        makeRawRow({
          group_message_id: "msg-a",
          group_external_id: "group-1",
          sender_phone: "+5511999990001",
        }),
        makeRawRow({
          group_message_id: "msg-b",
          group_external_id: "group-1",
          sender_phone: "+5511999990001",
        }),
        makeRawRow({
          group_message_id: "msg-c",
          group_external_id: "group-2",
          sender_phone: "+5511999990001",
        }),
      ],
    ]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    const preview = await svc.previewByPhone({ phone: "5511999990001" });
    expect(preview.messageCount).toBe(3);
    expect(preview.groupCount).toBe(2);
    expect(preview.senderCount).toBe(1);
    expect(preview.allowlistConflict).toBeNull();
    expect(preview.blacklistedAlready).toBe(false);
  });

  it("marca blacklistedAlready quando phone já existe na blacklist global", async () => {
    const { db } = makeDb([
      [], // allowlist (vazio)
      [{ id: "bl-policy-1" }], // blacklist existe
      [], // fetchByPhoneRows
    ]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    const preview = await svc.previewByPhone({ phone: "5511999990001" });
    expect(preview.blacklistedAlready).toBe(true);
  });
});

// ─── executeByPhone ──────────────────────────────────────────────────────────

describe("GroupMessagesRemovalService.executeByPhone", () => {
  it("aborta com AllowlistConflictError quando phone em allowlist", async () => {
    const { db } = makeDb([
      [
        {
          id: "policy-1",
          phone: "+5511999990001",
          sender_external_id: null,
          group_external_id: null,
          reason: null,
        },
      ],
    ]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    await expect(svc.executeByPhone({ phone: "5511999990001" })).rejects.toBeInstanceOf(
      AllowlistConflictError
    );
  });

  it("adiciona blacklist e enfileira jobs de delete_message e remove_participant", async () => {
    const row = makeRawRow();
    const { db, execute } = makeDb([
      [], // allowlist check
      [row], // fetchByPhoneRows
      [], // INSERT message_moderations (retorno ignorado)
    ]);
    const phonePoliciesService = makePhonePoliciesService();
    const { service: taskService, enqueue } = makeTaskService();

    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService,
      taskService,
    });
    const result = await svc.executeByPhone({ phone: "5511999990001" });

    expect(result.blacklistAdded).toBe(true);
    expect(result.alreadyBlacklisted).toBe(false);
    expect(result.messagesDeleteEnqueued).toBe(1);
    expect(result.participantsRemoveEnqueued).toBe(1);
    expect(phonePoliciesService.add).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);

    const enqueuedJobs = (enqueue.mock.calls[0]?.[0] as JobSchema[]) ?? [];
    const deleteJob = enqueuedJobs.find((j) => j.type === "whatsapp.delete_message");
    expect(deleteJob?.payload).toMatchObject({
      providerInstanceId: row.provider_instance_id,
      messageId: row.external_message_id,
      phone: row.group_external_id,
      owner: false,
    });
    const removeJob = enqueuedJobs.find((j) => j.type === "whatsapp.remove_participant");
    expect(removeJob?.payload).toMatchObject({
      providerInstanceId: row.provider_instance_id,
      groupId: row.group_external_id,
      phones: [row.sender_phone],
    });

    // query 1 é o allowlist check, query 2 é o fetchByPhoneRows
    expect(execute).toHaveBeenCalled();
  });

  it("marca alreadyBlacklisted quando phonePoliciesService.add retorna ConflictError", async () => {
    const row = makeRawRow();
    const { db } = makeDb([
      [], // allowlist
      [row], // fetchByPhoneRows
      [], // INSERT moderation
    ]);
    const phonePoliciesService = makePhonePoliciesService({
      add: mock(() => Promise.reject(new PhonePolicyConflictError("dup"))),
    } as unknown as Partial<PhonePoliciesService>);
    const { service: taskService } = makeTaskService();
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService,
      taskService,
    });

    const result = await svc.executeByPhone({ phone: "5511999990001" });
    expect(result.blacklistAdded).toBe(false);
    expect(result.alreadyBlacklisted).toBe(true);
    expect(result.messagesDeleteEnqueued).toBe(1);
  });

  it("não enfileira remove_participant quando sender_phone é null (LID-only)", async () => {
    const row = makeRawRow({ sender_phone: null, sender_external_id: "1234567890@lid" });
    const { db } = makeDb([
      [], // allowlist
      [row], // fetchByPhoneRows
      [], // INSERT moderation
    ]);
    const { service: taskService, enqueue } = makeTaskService();
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService,
    });

    // LID-only não casa com sender_phone ILIKE — mas simulamos retorno mesmo assim
    // para validar o comportamento do publisher.
    const result = await svc.executeByPhone({ phone: "5511999990001" });
    expect(result.messagesDeleteEnqueued).toBe(1);
    expect(result.participantsRemoveEnqueued).toBe(0);
    const jobs = (enqueue.mock.calls[0]?.[0] as JobSchema[]) ?? [];
    expect(jobs.some((j) => j.type === "whatsapp.remove_participant")).toBe(false);
  });
});

// ─── BySpam ───────────────────────────────────────────────────────────────────

describe("GroupMessagesRemovalService.previewBySpam", () => {
  it("conta mensagens excluídas por allowlist", async () => {
    const { db } = makeDb([
      [
        makeRawRow({ group_message_id: "msg-a", allowlist_policy_id: null }),
        makeRawRow({ group_message_id: "msg-b", allowlist_policy_id: null }),
        makeRawRow({ group_message_id: "msg-c", allowlist_policy_id: "byp-1" }),
      ],
    ]);
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService: makePhonePoliciesService(),
      taskService: makeTaskService().service,
    });
    const preview = await svc.previewBySpam({ filters: ["tk7.games"] });
    expect(preview.messageCount).toBe(2);
    expect(preview.excludedByAllowlistCount).toBe(1);
  });
});

describe("GroupMessagesRemovalService.executeBySpam", () => {
  it("filtra msgs em allowlist e não adiciona blacklist", async () => {
    const { db } = makeDb([
      [
        makeRawRow({ group_message_id: "msg-a", allowlist_policy_id: null }),
        makeRawRow({ group_message_id: "msg-b", allowlist_policy_id: "byp-1" }),
      ],
      [], // INSERT moderation
    ]);
    const phonePoliciesService = makePhonePoliciesService();
    const { service: taskService, enqueue } = makeTaskService();
    const svc = new GroupMessagesRemovalService({
      db,
      phonePoliciesService,
      taskService,
    });

    const result = await svc.executeBySpam({ filters: ["tk7.games"] });
    expect(result.mode).toBe("by-spam");
    expect(result.excludedByAllowlistCount).toBe(1);
    expect(result.messagesDeleteEnqueued).toBe(1);
    expect(phonePoliciesService.add).toHaveBeenCalledTimes(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
