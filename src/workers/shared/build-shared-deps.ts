import type { Connection, Publisher } from "rabbitmq-client";
import { env } from "../../config/env.ts";
import { createDbConnection, createDrizzleDb, type Db } from "../../db/client.ts";
import { TaskRepository } from "../../db/repositories/task-repository.ts";
import { declareJobTopologies, type JobTopologies } from "../../jobs/topology.ts";
import { createAmqpConnection } from "../../lib/amqp.ts";
import { createRedisConnection } from "../../lib/redis.ts";
import { TaskService } from "../../services/task/index.ts";

export type SharedDeps = {
  redis: ReturnType<typeof createRedisConnection>;
  sql: ReturnType<typeof createDbConnection>;
  db: Db;
  rabbit: Connection;
  publisher: Publisher;
  topologies: JobTopologies;
  taskRepo: TaskRepository;
  taskService: TaskService;
};

export async function buildSharedDeps(): Promise<SharedDeps> {
  const redis = createRedisConnection(env.REDIS_URL);
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);

  const rabbit = createAmqpConnection();
  const publisher = rabbit.createPublisher({ confirm: true, maxAttempts: 2 });

  const topologies = await declareJobTopologies(rabbit);

  const taskRepo = new TaskRepository(db);
  const taskService = new TaskService({ repo: taskRepo, publisher });

  return {
    redis,
    sql,
    db,
    rabbit,
    publisher,
    topologies,
    taskRepo,
    taskService,
  };
}

export async function closeSharedDeps(deps: SharedDeps): Promise<void> {
  try {
    await deps.publisher.close();
    await deps.rabbit.close();
    await deps.sql.end();
    deps.redis.disconnect();
  } catch {
    // best-effort: shutdown não deve lançar
  }
}
