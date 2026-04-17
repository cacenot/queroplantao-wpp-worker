export interface InstanceZApiView {
  zapiInstanceId: string;
  instanceTokenMasked: string;
  webhookBaseUrl: string | null;
  currentConnectionState: "unknown" | "connected" | "disconnected" | "pending" | "errored" | null;
  currentConnected: boolean | null;
  currentPhoneNumber: string | null;
  lastStatusSyncedAt: string | null;
}

export interface InstanceView {
  id: string;
  protocol: "whatsapp" | "telegram";
  providerKind: "whatsapp_zapi" | "whatsapp_whatsmeow" | "whatsapp_business_api" | "telegram_bot";
  displayName: string;
  isEnabled: boolean;
  executionStrategy: "leased" | "passthrough";
  redisKey: string | null;
  cooldownMinMs: number | null;
  cooldownMaxMs: number | null;
  safetyTtlMs: number | null;
  heartbeatIntervalMs: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  zapi: InstanceZApiView | null;
}

export interface PaginationMeta {
  limit: number;
  offset: number;
  total: number;
}

export interface CreateZApiInstanceInput {
  displayName: string;
  zapiInstanceId: string;
  instanceToken: string;
  webhookBaseUrl?: string | null;
  executionStrategy?: "leased" | "passthrough";
  redisKey?: string | null;
  cooldownMinMs?: number | null;
  cooldownMaxMs?: number | null;
  safetyTtlMs?: number | null;
  heartbeatIntervalMs?: number | null;
}

export interface ListFilters {
  protocol?: "whatsapp" | "telegram";
  providerKind?: "whatsapp_zapi" | "whatsapp_whatsmeow" | "whatsapp_business_api" | "telegram_bot";
  isEnabled?: boolean;
}

export const RESTART_WARNING = "A instância só será utilizada pelo worker após o próximo restart.";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
