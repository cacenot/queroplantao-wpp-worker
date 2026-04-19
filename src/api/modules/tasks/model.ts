import { Elysia, t } from "elysia";
import { z } from "zod";
import { jobSchema } from "../../../jobs/schemas.ts";

export const tasksModel = new Elysia({ name: "tasksModel" }).model({
  "tasks.enqueue.response": t.Object({
    accepted: t.Integer(),
    duplicates: t.Integer(),
  }),
});

// Mantido em Zod porque jobSchema é um discriminatedUnion compartilhado com o worker.
export const batchSchema = z.array(jobSchema).min(1).max(1000);
