import { t } from "elysia";

const instanceZApiViewSchema = t.Object({
  zapiInstanceId: t.String(),
  instanceTokenMasked: t.String(),
  webhookBaseUrl: t.Nullable(t.String()),
  currentConnectionState: t.Nullable(
    t.Union([
      t.Literal("unknown"),
      t.Literal("connected"),
      t.Literal("disconnected"),
      t.Literal("pending"),
      t.Literal("errored"),
    ])
  ),
  currentConnected: t.Nullable(t.Boolean()),
  currentPhoneNumber: t.Nullable(t.String()),
  lastStatusSyncedAt: t.Nullable(t.String({ format: "date-time" })),
});

export const instanceViewSchema = t.Object({
  id: t.String({ format: "uuid" }),
  protocol: t.Union([t.Literal("whatsapp"), t.Literal("telegram")]),
  providerKind: t.Union([
    t.Literal("whatsapp_zapi"),
    t.Literal("whatsapp_whatsmeow"),
    t.Literal("whatsapp_business_api"),
    t.Literal("telegram_bot"),
  ]),
  displayName: t.String(),
  isEnabled: t.Boolean(),
  executionStrategy: t.Union([t.Literal("leased"), t.Literal("passthrough")]),
  redisKey: t.Nullable(t.String()),
  cooldownMinMs: t.Nullable(t.Integer()),
  cooldownMaxMs: t.Nullable(t.Integer()),
  safetyTtlMs: t.Nullable(t.Integer()),
  heartbeatIntervalMs: t.Nullable(t.Integer()),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
  archivedAt: t.Nullable(t.String({ format: "date-time" })),
  zapi: t.Nullable(instanceZApiViewSchema),
});

export const createZApiInstanceBodySchema = t.Object({
  displayName: t.String({ minLength: 1, maxLength: 200 }),
  zapiInstanceId: t.String({ minLength: 1 }),
  instanceToken: t.String({ minLength: 1 }),
  webhookBaseUrl: t.Optional(t.String({ format: "uri" })),
  executionStrategy: t.Optional(t.Union([t.Literal("leased"), t.Literal("passthrough")])),
  redisKey: t.Optional(t.String({ minLength: 1 })),
  cooldownMinMs: t.Optional(t.Integer({ minimum: 0 })),
  cooldownMaxMs: t.Optional(t.Integer({ minimum: 0 })),
  safetyTtlMs: t.Optional(t.Integer({ minimum: 1 })),
  heartbeatIntervalMs: t.Optional(t.Integer({ minimum: 1 })),
});

export const listQuerySchema = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
  protocol: t.Optional(t.Union([t.Literal("whatsapp"), t.Literal("telegram")])),
  providerKind: t.Optional(
    t.Union([
      t.Literal("whatsapp_zapi"),
      t.Literal("whatsapp_whatsmeow"),
      t.Literal("whatsapp_business_api"),
      t.Literal("telegram_bot"),
    ])
  ),
  isEnabled: t.Optional(t.BooleanString()),
});

export const idParamSchema = t.Object({
  id: t.String({ format: "uuid" }),
});

export const createResponseSchema = t.Object({
  data: instanceViewSchema,
  warning: t.String(),
});

export const getResponseSchema = t.Object({
  data: instanceViewSchema,
});

export const listResponseSchema = t.Object({
  data: t.Array(instanceViewSchema),
  pagination: t.Object({
    limit: t.Integer(),
    offset: t.Integer(),
    total: t.Integer(),
  }),
});

export const toggleResponseSchema = t.Object({
  data: instanceViewSchema,
  warning: t.String(),
});

export const errorResponseSchema = t.Object({
  error: t.String(),
  details: t.Optional(t.Unknown()),
});
