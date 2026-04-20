import { Elysia, t } from "elysia";

export const phonePolicyViewSchema = t.Object({
  id: t.String({ format: "uuid" }),
  protocol: t.Union([t.Literal("whatsapp"), t.Literal("telegram")]),
  kind: t.Union([t.Literal("blacklist"), t.Literal("bypass")]),
  phone: t.String(),
  groupExternalId: t.Nullable(t.String()),
  source: t.Union([
    t.Literal("manual"),
    t.Literal("moderation_auto"),
    t.Literal("group_admin_sync"),
    t.Literal("admin_api_sync"),
  ]),
  reason: t.Nullable(t.String()),
  notes: t.Nullable(t.String()),
  moderationId: t.Nullable(t.String({ format: "uuid" })),
  metadata: t.Record(t.String(), t.Unknown()),
  expiresAt: t.Nullable(t.String({ format: "date-time" })),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const createBodySchema = t.Object({
  protocol: t.Union([t.Literal("whatsapp"), t.Literal("telegram")]),
  phone: t.String({ pattern: "^\\d{8,15}$" }),
  groupExternalId: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  reason: t.Optional(t.Nullable(t.String())),
  notes: t.Optional(t.Nullable(t.String())),
});

const listQuerySchema = t.Object({
  protocol: t.Optional(t.Union([t.Literal("whatsapp"), t.Literal("telegram")])),
  phone: t.Optional(t.String()),
  groupExternalId: t.Optional(t.String()),
  source: t.Optional(
    t.Union([
      t.Literal("manual"),
      t.Literal("moderation_auto"),
      t.Literal("group_admin_sync"),
      t.Literal("admin_api_sync"),
    ])
  ),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
});

const idParamSchema = t.Object({ id: t.String({ format: "uuid" }) });

export const createResponseSchema = t.Object({ data: phonePolicyViewSchema });
export const getResponseSchema = t.Object({ data: phonePolicyViewSchema });
export const listResponseSchema = t.Object({
  data: t.Array(phonePolicyViewSchema),
  pagination: t.Object({
    limit: t.Integer(),
    offset: t.Integer(),
    total: t.Integer(),
  }),
});

export const phoneBypassModel = new Elysia({ name: "phoneBypassModel" }).model({
  "phoneBypass.create.body": createBodySchema,
  "phoneBypass.list.query": listQuerySchema,
  "phoneBypass.id.params": idParamSchema,
});
