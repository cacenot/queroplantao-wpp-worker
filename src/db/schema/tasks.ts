import { index, integer, jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "dropped",
]);

export const taskTypeEnum = pgEnum("task_type", [
  "whatsapp.delete_message",
  "whatsapp.remove_participant",
  "whatsapp.moderate_group_message",
  "whatsapp.ingest_participant_event",
  "whatsapp.join_group_via_invite",
]);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey(),
    type: taskTypeEnum("type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: taskStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    error: jsonb("error").$type<{ message: string; name?: string; stack?: string } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    statusCreatedIdx: index("tasks_status_created_at_idx").on(table.status, table.createdAt),
    typeStatusIdx: index("tasks_type_status_idx").on(table.type, table.status),
  })
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
