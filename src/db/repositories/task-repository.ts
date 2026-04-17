import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { type NewTask, type Task, tasks } from "../schema/tasks.ts";

export interface TaskFilters {
  status?: Task["status"];
  type?: Task["type"];
}

export interface TaskPagination {
  limit: number;
  offset: number;
}

export class TaskRepository {
  constructor(private readonly db: Db) {}

  async insertMany(rows: NewTask[]): Promise<{ inserted: number; ids: string[] }> {
    if (rows.length === 0) return { inserted: 0, ids: [] };

    const returned = await this.db
      .insert(tasks)
      .values(rows)
      .onConflictDoNothing({ target: tasks.id })
      .returning({ id: tasks.id });

    return { inserted: returned.length, ids: returned.map((r) => r.id) };
  }

  async markQueued(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ status: "queued", queuedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.status, "pending")));
  }

  async claimForExecution(id: string): Promise<Task | null> {
    const [row] = await this.db
      .update(tasks)
      .set({
        status: "running",
        startedAt: new Date(),
        attempt: sql`${tasks.attempt} + 1`,
        updatedAt: new Date(),
      })
      // `running` aceito para cobrir redelivery pós-REQUEUE quando markRetrying falhou
      .where(and(eq(tasks.id, id), inArray(tasks.status, ["queued", "pending", "running"])))
      .returning();

    return row ?? null;
  }

  async markRetrying(id: string): Promise<boolean> {
    const [row] = await this.db
      .update(tasks)
      .set({ status: "queued", queuedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.status, "running")))
      .returning({ id: tasks.id });
    return row !== undefined;
  }

  async markSucceeded(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ status: "succeeded", completedAt: new Date(), error: null, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  async markFailed(
    id: string,
    error: { message: string; name?: string; stack?: string }
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({ status: "failed", completedAt: new Date(), error, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  async markDropped(id: string, reason: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        status: "dropped",
        completedAt: new Date(),
        error: { message: reason },
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));
  }

  async findById(id: string): Promise<Task | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return row ?? null;
  }

  async list(
    filters: TaskFilters,
    pagination: TaskPagination
  ): Promise<{ rows: Task[]; total: number }> {
    const conditions = this.buildFilters(filters);

    const rows = await this.db
      .select()
      .from(tasks)
      .where(conditions)
      .orderBy(desc(tasks.createdAt))
      .limit(pagination.limit)
      .offset(pagination.offset);

    const [totalRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(conditions);

    return { rows, total: totalRow?.count ?? 0 };
  }

  private buildFilters(filters: TaskFilters) {
    const conditions = [];

    if (filters.status) {
      conditions.push(eq(tasks.status, filters.status));
    }
    if (filters.type) {
      conditions.push(eq(tasks.type, filters.type));
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }
}
