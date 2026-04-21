import { describe, expect, it, mock } from "bun:test";

import type { TaskRepository } from "../../db/repositories/task-repository.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { TaskService } from "./task-service.ts";

const PROVIDER_INSTANCE_ID = "11111111-1111-1111-1111-111111111111";

function makeJob(id: string, overrides: Partial<JobSchema> = {}): JobSchema {
  return {
    id,
    type: "whatsapp.delete_message",
    createdAt: "2026-04-10T00:00:00.000Z",
    payload: {
      providerInstanceId: PROVIDER_INSTANCE_ID,
      messageId: "msg-1",
      phone: "+5511999999999",
      owner: true,
    },
    ...overrides,
  } as JobSchema;
}

function makeRepo(overrides: Partial<Record<keyof TaskRepository, unknown>> = {}) {
  return {
    insertMany: mock((rows: { id: string }[]) =>
      Promise.resolve({ inserted: rows.length, ids: rows.map((r) => r.id) })
    ),
    markQueued: mock(() => Promise.resolve()),
    claimForExecution: mock(() => Promise.resolve(null)),
    markRetrying: mock(() => Promise.resolve(true)),
    markSucceeded: mock(() => Promise.resolve()),
    markFailed: mock(() => Promise.resolve()),
    markDropped: mock(() => Promise.resolve()),
    findById: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve({ rows: [], total: 0 })),
    ...overrides,
  };
}

function makePublisher(
  sendImpl: (
    envelope: { routingKey: string; durable: boolean },
    body: unknown
  ) => Promise<void> = () => Promise.resolve()
) {
  return {
    send: mock(sendImpl),
  };
}

function makeService(
  overrides: {
    repo?: ReturnType<typeof makeRepo>;
    publisher?: ReturnType<typeof makePublisher>;
    queueName?: string;
  } = {}
) {
  const repo = overrides.repo ?? makeRepo();
  const publisher = overrides.publisher ?? makePublisher();
  const queueName = overrides.queueName ?? "wpp.actions";

  const service = new TaskService({
    // biome-ignore lint/suspicious/noExplicitAny: fake repo tipado via makeRepo
    repo: repo as any,
    publisher,
    queueName,
  });

  return { service, repo, publisher, queueName };
}

describe("TaskService.enqueue", () => {
  it("publica todos os jobs inseridos em paralelo", async () => {
    const jobA = makeJob("550e8400-e29b-41d4-a716-446655440001");
    const jobB = makeJob("550e8400-e29b-41d4-a716-446655440002");
    const jobC = makeJob("550e8400-e29b-41d4-a716-446655440003");

    const sendOrder: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const publisher = makePublisher(async (_env, body) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const job = body as JobSchema;
      await new Promise((r) => setTimeout(r, 5));
      sendOrder.push(job.id);
      concurrent--;
    });

    const { service, repo } = makeService({ publisher });

    const result = await service.enqueue([jobA, jobB, jobC]);

    expect(publisher.send).toHaveBeenCalledTimes(3);
    expect(sendOrder.sort()).toEqual([jobA.id, jobB.id, jobC.id].sort());
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(repo.markQueued).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      accepted: 3,
      duplicates: 0,
      ids: [jobA.id, jobB.id, jobC.id],
    });
  });

  it("não publica jobs duplicados (não presentes em insertedSet)", async () => {
    const jobA = makeJob("550e8400-e29b-41d4-a716-446655440001");
    const jobB = makeJob("550e8400-e29b-41d4-a716-446655440002");
    const jobC = makeJob("550e8400-e29b-41d4-a716-446655440003");

    const repo = makeRepo({
      insertMany: mock(() => Promise.resolve({ inserted: 1, ids: [jobB.id] })),
    });
    const publisher = makePublisher();
    const { service } = makeService({ repo, publisher });

    const result = await service.enqueue([jobA, jobB, jobC]);

    expect(publisher.send).toHaveBeenCalledTimes(1);
    expect(publisher.send).toHaveBeenCalledWith({ routingKey: "wpp.actions", durable: true }, jobB);
    expect(repo.markQueued).toHaveBeenCalledTimes(1);
    expect(repo.markQueued).toHaveBeenCalledWith(jobB.id);
    expect(result).toEqual({ accepted: 1, duplicates: 2, ids: [jobB.id] });
  });

  it("falha de publish em 1 job não afeta os outros", async () => {
    const jobA = makeJob("550e8400-e29b-41d4-a716-446655440001");
    const jobB = makeJob("550e8400-e29b-41d4-a716-446655440002");
    const jobC = makeJob("550e8400-e29b-41d4-a716-446655440003");

    const publisher = makePublisher(async (_env, body) => {
      const job = body as JobSchema;
      if (job.id === jobB.id) throw new Error("broker fora");
    });

    const { service, repo } = makeService({ publisher });

    const result = await service.enqueue([jobA, jobB, jobC]);

    expect(publisher.send).toHaveBeenCalledTimes(3);
    // jobB falhou → não deve ter markQueued. jobA e jobC sim.
    expect(repo.markQueued).toHaveBeenCalledTimes(2);
    // biome-ignore lint/suspicious/noExplicitAny: overrides usa unknown, mas markQueued é sempre mock
    const markedIds = ((repo.markQueued as any).mock.calls as [string][]).map(([id]) => id).sort();
    expect(markedIds).toEqual([jobA.id, jobC.id].sort());
    expect(result).toEqual({
      accepted: 3,
      duplicates: 0,
      ids: [jobA.id, jobB.id, jobC.id],
    });
  });

  it("retorna { accepted, duplicates, ids } corretamente", async () => {
    const jobA = makeJob("550e8400-e29b-41d4-a716-446655440001");
    const jobB = makeJob("550e8400-e29b-41d4-a716-446655440002");

    const repo = makeRepo({
      insertMany: mock(() => Promise.resolve({ inserted: 1, ids: [jobA.id] })),
    });
    const { service } = makeService({ repo });

    const result = await service.enqueue([jobA, jobB]);

    expect(result.accepted).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.ids).toEqual([jobA.id]);
  });
});
