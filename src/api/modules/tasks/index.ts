import { Elysia } from "elysia";
import { logger } from "../../../lib/logger.ts";
import type { TaskService } from "../../../services/task/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { bodyLimitPlugin } from "../../shared/body-limit.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import { batchSchema, tasksModel } from "./model.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;

export interface TasksModuleDeps {
  taskService: TaskService;
}

export function tasksModule(deps: TasksModuleDeps) {
  const { taskService } = deps;

  return new Elysia({ name: "tasks-module", tags: ["tasks"] })
    .use(authPlugin)
    .use(bodyLimitPlugin({ max: MAX_BODY_SIZE }))
    .use(tasksModel)
    .post(
      "/tasks",
      async ({ body, set }) => {
        const result = batchSchema.safeParse(body);
        if (!result.success) {
          set.status = 400;
          return { error: "Validation failed", details: result.error.flatten() };
        }

        const jobs = result.data;
        const { accepted, duplicates } = await taskService.enqueue(jobs);

        logger.info({ accepted, duplicates }, "Batch de jobs enfileirado via HTTP");

        set.status = 202;
        return { accepted, duplicates };
      },
      {
        response: {
          202: "tasks.enqueue.response",
          400: errorResponseSchema,
          413: errorResponseSchema,
        },
        detail: { summary: "Persiste e publica um batch de jobs no AMQP" },
      }
    );
}
