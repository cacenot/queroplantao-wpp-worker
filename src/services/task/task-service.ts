import type { TaskRepository } from "../../db/repositories/task-repository.ts";
import type { Task } from "../../db/schema/tasks.ts";
import { priorityForJob, queueForJob } from "../../jobs/routing.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { logger } from "../../lib/logger.ts";
import type { EnqueueResult, PaginationMeta, TaskListFilters, TaskView } from "./types.ts";

type PublishEnvelope = {
  routingKey: string;
  durable: boolean;
  priority?: number;
};

type Publisher = {
  send(envelope: PublishEnvelope, body: unknown): Promise<void>;
};

type TaskServiceOptions = {
  repo: TaskRepository;
  publisher?: Publisher;
};

export class TaskService {
  private readonly repo: TaskRepository;
  private readonly publisher?: Publisher;

  constructor(options: TaskServiceOptions) {
    this.repo = options.repo;
    this.publisher = options.publisher;
  }

  async enqueue(jobs: JobSchema[]): Promise<EnqueueResult> {
    if (!this.publisher) {
      throw new Error("TaskService: publisher é obrigatório para enqueue");
    }
    const publisher = this.publisher;

    const rows = jobs.map((job) => ({
      id: job.id,
      type: job.type,
      payload: job.payload,
      status: "pending" as const,
      attempt: job.attempt ?? 0,
      createdAt: new Date(job.createdAt),
    }));

    const { inserted, ids } = await this.repo.insertMany(rows);
    const duplicates = jobs.length - inserted;
    const insertedSet = new Set(ids);

    await Promise.all(
      jobs
        .filter((job) => insertedSet.has(job.id))
        .map(async (job) => {
          try {
            await publisher.send(
              {
                routingKey: queueForJob(job.type),
                durable: true,
                priority: priorityForJob(job.type),
              },
              job
            );
            await this.repo.markQueued(job.id);
          } catch (err) {
            logger.warn(
              { err, jobId: job.id },
              "Falha ao publicar job no AMQP — task fica pending para reaper"
            );
          }
        })
    );

    return { accepted: inserted, duplicates, ids };
  }

  async claimForExecution(id: string): Promise<Task | null> {
    return this.repo.claimForExecution(id);
  }

  async markRetrying(id: string): Promise<boolean> {
    return this.repo.markRetrying(id);
  }

  async markSucceeded(id: string): Promise<void> {
    await this.repo.markSucceeded(id);
  }

  async markFailed(id: string, err: unknown): Promise<void> {
    const error =
      err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : { message: String(err) };
    await this.repo.markFailed(id, error);
  }

  async markDropped(id: string, reason: string): Promise<void> {
    await this.repo.markDropped(id, reason);
  }

  async get(id: string): Promise<TaskView | null> {
    const row = await this.repo.findById(id);
    return row ? toTaskView(row) : null;
  }

  async list(
    filters: TaskListFilters,
    pagination: { limit: number; offset: number }
  ): Promise<{ data: TaskView[]; pagination: PaginationMeta }> {
    const { rows, total } = await this.repo.list(filters, pagination);
    return {
      data: rows.map(toTaskView),
      pagination: { ...pagination, total },
    };
  }
}

function toTaskView(row: Task): TaskView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempt: row.attempt,
    payload: row.payload,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    queuedAt: row.queuedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
