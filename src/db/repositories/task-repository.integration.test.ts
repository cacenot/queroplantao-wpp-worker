import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

process.env.DATABASE_URL ??= "postgres://postgres:secret@localhost:5432/queroplantao_messaging";
process.env.AMQP_URL ??= "amqp://localhost";
process.env.AMQP_QUEUE ??= "wpp.actions";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.HTTP_API_KEY ??= "test-key";
process.env.ZAPI_BASE_URL ??= "https://test.example.com";
process.env.ZAPI_CLIENT_TOKEN ??= "test-client-token";
process.env.QP_ADMIN_API_URL ??= "https://qp-admin.example.com";
process.env.QP_ADMIN_API_TOKEN ??= "test-admin-token";

const { createTestDb } = await import("../../test-support/db.ts");
const { TaskRepository } = await import("./task-repository.ts");
const { tasks } = await import("../schema/tasks.ts");

import type { NewTask } from "../schema/tasks.ts";

const INTEGRATION = process.env.INTEGRATION === "1";

function uuid(n: number) {
  return `550e8400-e29b-41d4-a716-${String(n).padStart(12, "0")}`;
}

function pendingRow(id: string, overrides: Partial<NewTask> = {}): NewTask {
  return {
    id,
    type: "whatsapp.delete_message",
    payload: { messageId: "m1", phone: "5511999990001", owner: true },
    status: "pending",
    attempt: 0,
    ...overrides,
  };
}

describe.skipIf(!INTEGRATION)("TaskRepository (integration)", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let repo: InstanceType<typeof TaskRepository>;

  beforeAll(async () => {
    testDb = await createTestDb();
    repo = new TaskRepository(testDb.db);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  beforeEach(async () => {
    await testDb.sql`TRUNCATE TABLE tasks RESTART IDENTITY CASCADE`;
  });

  describe("insertMany", () => {
    it("insere um batch e retorna ids", async () => {
      const res = await repo.insertMany([pendingRow(uuid(1)), pendingRow(uuid(2))]);
      expect(res.inserted).toBe(2);
      expect(res.ids).toEqual([uuid(1), uuid(2)]);
    });

    it("é idempotente por id (onConflictDoNothing)", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      const second = await repo.insertMany([pendingRow(uuid(1)), pendingRow(uuid(2))]);
      expect(second.inserted).toBe(1);
      expect(second.ids).toEqual([uuid(2)]);
    });

    it("noop com array vazio", async () => {
      const res = await repo.insertMany([]);
      expect(res).toEqual({ inserted: 0, ids: [] });
    });
  });

  describe("markQueued", () => {
    it("pending → queued e seta queuedAt", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.markQueued(uuid(1));

      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("queued");
      expect(row?.queuedAt).toBeInstanceOf(Date);
    });

    it("noop em outros estados", async () => {
      await repo.insertMany([pendingRow(uuid(1), { status: "running" })]);
      await repo.markQueued(uuid(1));
      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("running");
    });
  });

  describe("claimForExecution", () => {
    it("pending → running, attempt=1", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);

      const claimed = await repo.claimForExecution(uuid(1));

      expect(claimed?.status).toBe("running");
      expect(claimed?.attempt).toBe(1);
      expect(claimed?.startedAt).toBeInstanceOf(Date);
    });

    it("queued → running, attempt=1", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.markQueued(uuid(1));

      const claimed = await repo.claimForExecution(uuid(1));

      expect(claimed?.status).toBe("running");
      expect(claimed?.attempt).toBe(1);
    });

    it("running → running, attempt incrementa (redelivery pós-REQUEUE)", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.claimForExecution(uuid(1)); // attempt=1

      const claimed = await repo.claimForExecution(uuid(1)); // redelivery

      expect(claimed?.status).toBe("running");
      expect(claimed?.attempt).toBe(2);
    });

    it("retorna null em estados terminais", async () => {
      for (const status of ["succeeded", "failed", "dropped"] as const) {
        const id = uuid(Number.parseInt(status.slice(0, 3), 36));
        await repo.insertMany([pendingRow(id, { status })]);
        const claimed = await repo.claimForExecution(id);
        expect(claimed).toBeNull();
      }
    });

    it("retorna null para id inexistente", async () => {
      const claimed = await repo.claimForExecution(uuid(999));
      expect(claimed).toBeNull();
    });

    it("cenário de retry completo: claim → markRetrying → claim (attempt=2)", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);

      const first = await repo.claimForExecution(uuid(1));
      expect(first?.attempt).toBe(1);

      await repo.markRetrying(uuid(1));

      const second = await repo.claimForExecution(uuid(1));
      expect(second?.status).toBe("running");
      expect(second?.attempt).toBe(2);
    });
  });

  describe("markRetrying", () => {
    it("running → queued, attempt preservado", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.claimForExecution(uuid(1)); // attempt=1

      const ok = await repo.markRetrying(uuid(1));

      expect(ok).toBe(true);
      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("queued");
      expect(row?.attempt).toBe(1);
      expect(row?.queuedAt).toBeInstanceOf(Date);
    });

    it("retorna false se não está em running (queued/pending/terminal)", async () => {
      await repo.insertMany([
        pendingRow(uuid(1), { status: "queued" }),
        pendingRow(uuid(2), { status: "pending" }),
        pendingRow(uuid(3), { status: "succeeded" }),
      ]);

      expect(await repo.markRetrying(uuid(1))).toBe(false);
      expect(await repo.markRetrying(uuid(2))).toBe(false);
      expect(await repo.markRetrying(uuid(3))).toBe(false);
    });

    it("é idempotente: segunda chamada em queued retorna false", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.claimForExecution(uuid(1));
      expect(await repo.markRetrying(uuid(1))).toBe(true);
      expect(await repo.markRetrying(uuid(1))).toBe(false);
    });
  });

  describe("markSucceeded", () => {
    it("seta status=succeeded, completedAt e limpa error", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.markFailed(uuid(1), { message: "x" }); // seed do error
      await repo.markSucceeded(uuid(1));

      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("succeeded");
      expect(row?.completedAt).toBeInstanceOf(Date);
      expect(row?.error).toBeNull();
    });
  });

  describe("markFailed", () => {
    it("grava error estruturado", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);

      await repo.markFailed(uuid(1), {
        message: "boom",
        name: "BoomError",
        stack: "Error: boom\n  at ...",
      });

      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("failed");
      expect(row?.error).toEqual({
        message: "boom",
        name: "BoomError",
        stack: "Error: boom\n  at ...",
      });
    });
  });

  describe("markDropped", () => {
    it("grava status=dropped e error.message = reason", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      await repo.markDropped(uuid(1), "schema_invalid");

      const row = await repo.findById(uuid(1));
      expect(row?.status).toBe("dropped");
      expect(row?.error).toEqual({ message: "schema_invalid" });
    });
  });

  describe("list", () => {
    it("filtra por status e pagina", async () => {
      await repo.insertMany([
        pendingRow(uuid(1), { status: "queued" }),
        pendingRow(uuid(2), { status: "queued" }),
        pendingRow(uuid(3), { status: "failed" }),
      ]);

      const queued = await repo.list({ status: "queued" }, { limit: 10, offset: 0 });
      expect(queued.total).toBe(2);
      expect(queued.rows).toHaveLength(2);

      const failed = await repo.list({ status: "failed" }, { limit: 10, offset: 0 });
      expect(failed.total).toBe(1);
    });

    it("retorna total mesmo quando limit < total", async () => {
      await repo.insertMany([pendingRow(uuid(1)), pendingRow(uuid(2)), pendingRow(uuid(3))]);

      const res = await repo.list({}, { limit: 1, offset: 0 });
      expect(res.total).toBe(3);
      expect(res.rows).toHaveLength(1);
    });
  });

  describe("findById", () => {
    it("retorna null para id inexistente", async () => {
      expect(await repo.findById(uuid(999))).toBeNull();
    });
  });

  describe("tabela tasks acessível", () => {
    it("schema drizzle aponta para o schema de teste", async () => {
      await repo.insertMany([pendingRow(uuid(1))]);
      const rows = await testDb.db.select().from(tasks);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(uuid(1));
    });
  });
});
