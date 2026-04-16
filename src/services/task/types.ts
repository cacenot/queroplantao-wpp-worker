import type { Task } from "../../db/schema/tasks.ts";

export type TaskStatus = Task["status"];
export type TaskType = Task["type"];

export interface TaskView {
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
}

export interface EnqueueResult {
  accepted: number;
  duplicates: number;
  ids: string[];
}

export interface TaskListFilters {
  status?: TaskStatus;
  type?: TaskType;
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}
