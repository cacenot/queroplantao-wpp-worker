import type { Task } from "../../db/schema/tasks.ts";

export type TaskStatus = Task["status"];
export type TaskType = Task["type"];

export type TaskView = {
  id: string;
  type: TaskType;
  status: TaskStatus;
  attempt: number;
  payload: unknown;
  error: { message: string; name?: string; stack?: string } | null;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type EnqueueResult = {
  accepted: number;
  duplicates: number;
  ids: string[];
};

export type TaskListFilters = {
  status?: TaskStatus;
  type?: TaskType;
};

export type PaginationMeta = {
  limit: number;
  offset: number;
  total: number;
};
