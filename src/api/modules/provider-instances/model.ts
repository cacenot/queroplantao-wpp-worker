import { Elysia, t } from "elysia";

const connectionStateUnion = t.Union([
  t.Literal("unknown"),
  t.Literal("connected"),
  t.Literal("disconnected"),
  t.Literal("pending"),
  t.Literal("errored"),
  t.Literal("unreachable"),
]);

export const instanceZApiViewSchema = t.Object({
  zapiInstanceId: t.String(),
  instanceTokenMasked: t.String(),
  customClientTokenMasked: t.Nullable(t.String()),
  currentConnectionState: t.Nullable(connectionStateUnion),
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
  redisKey: t.String(),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
  archivedAt: t.Nullable(t.String({ format: "date-time" })),
  zapi: t.Nullable(instanceZApiViewSchema),
});

const createBodySchema = t.Object(
  {
    displayName: t.String({ minLength: 1, maxLength: 200 }),
    zapiInstanceId: t.String({ minLength: 1 }),
    instanceToken: t.String({ minLength: 1 }),
    customClientToken: t.Optional(t.String({ minLength: 1 })),
    executionStrategy: t.Optional(t.Union([t.Literal("leased"), t.Literal("passthrough")])),
    redisKey: t.Optional(t.String({ minLength: 1, default: "qp:whatsapp" })),
  },
  { additionalProperties: false }
);

const updateBodySchema = t.Object(
  {
    displayName: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
    executionStrategy: t.Optional(t.Union([t.Literal("leased"), t.Literal("passthrough")])),
    redisKey: t.Optional(t.String({ minLength: 1 })),
    instanceToken: t.Optional(t.String({ minLength: 1 })),
    customClientToken: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);

const listQuerySchema = t.Object({
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

const idParamSchema = t.Object({
  id: t.String({ format: "uuid" }),
});

const createResponseSchema = t.Object({
  data: instanceViewSchema,
  warning: t.String(),
});

const getResponseSchema = t.Object({
  data: instanceViewSchema,
});

const listResponseSchema = t.Object({
  data: t.Array(instanceViewSchema),
  pagination: t.Object({
    limit: t.Integer(),
    offset: t.Integer(),
    total: t.Integer(),
  }),
});

const toggleResponseSchema = t.Object({
  data: instanceViewSchema,
  warning: t.String(),
});

const updateResponseSchema = t.Object({
  data: instanceViewSchema,
  warning: t.String(),
});

const refreshResponseSchema = t.Object({
  data: instanceViewSchema,
});

export const providerInstancesModel = new Elysia({ name: "providerInstancesModel" }).model({
  "providerInstances.create.body": createBodySchema,
  "providerInstances.update.body": updateBodySchema,
  "providerInstances.list.query": listQuerySchema,
  "providerInstances.id.params": idParamSchema,
  "providerInstances.create.response": createResponseSchema,
  "providerInstances.get.response": getResponseSchema,
  "providerInstances.list.response": listResponseSchema,
  "providerInstances.toggle.response": toggleResponseSchema,
  "providerInstances.update.response": updateResponseSchema,
  "providerInstances.refresh.response": refreshResponseSchema,
});
