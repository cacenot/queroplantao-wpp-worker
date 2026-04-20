import { describe, expect, it, mock } from "bun:test";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { JobSchema } from "../../jobs/schemas.ts";
import type { PhonePoliciesService, PhonePolicyView } from "../phone-policies/index.ts";
import type { TaskService } from "../task/index.ts";
import {
  type ModerationEnforcementInput,
  ModerationEnforcementService,
} from "./moderation-enforcement-service.ts";

const PROVIDER_ID = "00000000-0000-0000-0000-0000000000aa";
const MOD_ID = "00000000-0000-0000-0000-0000000000bb";
const GM_ID = "00000000-0000-0000-0000-0000000000cc";
const POLICY_ID = "00000000-0000-0000-0000-0000000000dd";

function makeView(overrides: Partial<PhonePolicyView> = {}): PhonePolicyView {
  return {
    id: POLICY_ID,
    protocol: "whatsapp",
    kind: "blacklist",
    phone: "+5511999990001",
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

type FakePhonePolicies = {
  isBlacklisted: ReturnType<typeof mock>;
  isBypassed: ReturnType<typeof mock>;
};
type FakeTask = { enqueue: ReturnType<typeof mock> };
type FakeRedis = { set: ReturnType<typeof mock> };

function makeService(
  overrides: {
    isBlacklisted?: PhonePolicyView | null;
    isBypassed?: PhonePolicyView | null;
    redisAcquired?: "OK" | null;
  } = {}
) {
  const phonePolicies: FakePhonePolicies = {
    isBlacklisted: mock(async () => overrides.isBlacklisted ?? null),
    isBypassed: mock(async () => overrides.isBypassed ?? null),
  };
  const task: FakeTask = {
    enqueue: mock(async () => ({ accepted: 1, duplicates: 0, ids: [] })),
  };
  const redisResult: "OK" | null =
    "redisAcquired" in overrides ? (overrides.redisAcquired ?? null) : "OK";
  const redis: FakeRedis = {
    set: mock(async () => redisResult),
  };
  const logger = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;

  const svc = new ModerationEnforcementService({
    phonePoliciesService: phonePolicies as unknown as PhonePoliciesService,
    taskService: task as unknown as TaskService,
    redis: redis as unknown as Redis,
    logger,
    removeParticipantDedupTtlSeconds: 300,
  });

  return { svc, phonePolicies, task, redis, logger };
}

function makeInput(
  overrides: Partial<ModerationEnforcementInput> = {}
): ModerationEnforcementInput {
  return {
    protocol: "whatsapp",
    groupExternalId: "120363@g.us",
    senderPhone: "+5511999990001",
    senderExternalId: "1234567890@lid",
    providerInstanceId: PROVIDER_ID,
    externalMessageId: "MSG-EXT-1",
    moderationId: MOD_ID,
    groupMessageId: GM_ID,
    ...overrides,
  };
}

describe("ModerationEnforcementService.evaluateAndEnforce", () => {
  it("no-op quando ambos identificadores são null", async () => {
    const { svc, phonePolicies, task, redis } = makeService();
    await svc.evaluateAndEnforce(makeInput({ senderPhone: null, senderExternalId: null }));
    expect(phonePolicies.isBypassed).not.toHaveBeenCalled();
    expect(phonePolicies.isBlacklisted).not.toHaveBeenCalled();
    expect(task.enqueue).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("no-op quando providerInstanceId é null", async () => {
    const { svc, phonePolicies, task } = makeService();
    await svc.evaluateAndEnforce(makeInput({ providerInstanceId: null }));
    expect(phonePolicies.isBlacklisted).not.toHaveBeenCalled();
    expect(task.enqueue).not.toHaveBeenCalled();
  });

  it("no-op quando bypass matcha (não consulta blacklist)", async () => {
    const { svc, phonePolicies, task } = makeService({
      isBypassed: makeView({ kind: "bypass" }),
    });
    await svc.evaluateAndEnforce(makeInput());
    expect(phonePolicies.isBypassed).toHaveBeenCalled();
    expect(phonePolicies.isBlacklisted).not.toHaveBeenCalled();
    expect(task.enqueue).not.toHaveBeenCalled();
  });

  it("no-op quando blacklist não matcha", async () => {
    const { svc, phonePolicies, task } = makeService({ isBlacklisted: null });
    await svc.evaluateAndEnforce(makeInput());
    expect(phonePolicies.isBlacklisted).toHaveBeenCalled();
    expect(task.enqueue).not.toHaveBeenCalled();
  });

  it("blacklist hit + dedup miss → enfileira delete + remove_participant", async () => {
    const { svc, task, redis } = makeService({
      isBlacklisted: makeView(),
      redisAcquired: "OK",
    });

    await svc.evaluateAndEnforce(makeInput());

    expect(redis.set).toHaveBeenCalledWith(
      "enforcement:remove:whatsapp:120363@g.us:+5511999990001",
      "1",
      "EX",
      300,
      "NX"
    );
    expect(task.enqueue).toHaveBeenCalledTimes(1);

    const enqueued = (task.enqueue.mock.calls[0]?.[0] as JobSchema[]) ?? [];
    expect(enqueued).toHaveLength(2);

    const [del, remove] = enqueued;
    expect(del?.type).toBe("whatsapp.delete_message");
    expect(del?.payload).toEqual({
      providerInstanceId: PROVIDER_ID,
      messageId: "MSG-EXT-1",
      phone: "+5511999990001",
      owner: false,
    });
    expect(remove?.type).toBe("whatsapp.remove_participant");
    expect(remove?.payload).toEqual({
      providerInstanceId: PROVIDER_ID,
      groupId: "120363@g.us",
      phones: ["+5511999990001"],
    });
  });

  it("blacklist hit + dedup hit → enfileira só delete (kick suprimido)", async () => {
    const { svc, task } = makeService({
      isBlacklisted: makeView(),
      redisAcquired: null,
    });

    await svc.evaluateAndEnforce(makeInput());

    const enqueued = (task.enqueue.mock.calls[0]?.[0] as JobSchema[]) ?? [];
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.type).toBe("whatsapp.delete_message");
  });

  it("propaga senderPhone em E.164 para dedup key e payloads", async () => {
    const { svc, task, redis } = makeService({
      isBlacklisted: makeView(),
      redisAcquired: "OK",
    });

    await svc.evaluateAndEnforce(makeInput({ senderPhone: "+5511999990001" }));

    expect(redis.set).toHaveBeenCalledWith(
      "enforcement:remove:whatsapp:120363@g.us:+5511999990001",
      "1",
      "EX",
      300,
      "NX"
    );
    const enqueued = (task.enqueue.mock.calls[0]?.[0] as JobSchema[]) ?? [];
    expect(enqueued[0]?.payload).toMatchObject({ phone: "+5511999990001" });
    expect(enqueued[1]?.payload).toMatchObject({ phones: ["+5511999990001"] });
  });

  it("blacklist matchou por LID mas senderPhone null → log warn, sem jobs", async () => {
    const { svc, task, logger } = makeService({
      isBlacklisted: makeView({ phone: null, senderExternalId: "1234567890@lid" }),
    });

    await svc.evaluateAndEnforce(makeInput({ senderPhone: null }));

    expect(task.enqueue).not.toHaveBeenCalled();
    expect((logger.warn as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  it("propaga match input correto para phonePolicies (phone + lid)", async () => {
    const { svc, phonePolicies } = makeService({ isBlacklisted: makeView() });

    await svc.evaluateAndEnforce(makeInput());

    expect(phonePolicies.isBypassed).toHaveBeenCalledWith({
      protocol: "whatsapp",
      groupExternalId: "120363@g.us",
      phone: "+5511999990001",
      senderExternalId: "1234567890@lid",
    });
    expect(phonePolicies.isBlacklisted).toHaveBeenCalledWith({
      protocol: "whatsapp",
      groupExternalId: "120363@g.us",
      phone: "+5511999990001",
      senderExternalId: "1234567890@lid",
    });
  });
});
