import type { ZApiConnectionState } from "../../db/repositories/messaging-provider-instance-repository.ts";

export type { ZApiConnectionState };

export type InstanceZApiView = {
  zapiInstanceId: string;
  instanceTokenMasked: string;
  customClientTokenMasked: string | null;
  currentConnectionState: ZApiConnectionState | null;
  currentConnected: boolean | null;
  currentPhoneNumber: string | null;
  lastStatusSyncedAt: string | null;
};

export type InstanceView = {
  id: string;
  protocol: "whatsapp" | "telegram";
  providerKind: "whatsapp_zapi" | "whatsapp_whatsmeow" | "whatsapp_business_api" | "telegram_bot";
  displayName: string;
  isEnabled: boolean;
  executionStrategy: "leased" | "passthrough";
  redisKey: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  zapi: InstanceZApiView | null;
};

export type PaginationMeta = {
  limit: number;
  offset: number;
  total: number;
};

export type CreateZApiInstanceInput = {
  displayName: string;
  zapiInstanceId: string;
  instanceToken: string;
  customClientToken?: string | null;
  executionStrategy?: "leased" | "passthrough";
  redisKey: string;
};

export type UpdateZApiInstanceInput = {
  displayName?: string;
  executionStrategy?: "leased" | "passthrough";
  redisKey?: string;
  instanceToken?: string;
  customClientToken?: string | null;
};

export type ListFilters = {
  protocol?: "whatsapp" | "telegram";
  providerKind?: "whatsapp_zapi" | "whatsapp_whatsmeow" | "whatsapp_business_api" | "telegram_bot";
  isEnabled?: boolean;
};

export const RESTART_WARNING = "A instância só será utilizada pelo worker após o próximo restart.";

export const DEFAULT_REDIS_KEY = "qp:whatsapp";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ZApiRefreshError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ZApiRefreshError";
  }
}
