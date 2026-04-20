import type { TLiteral, TUnion } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { CATEGORIES, type Category } from "../../../ai/categories.ts";

// Fonte única em `ai/categories.ts` — evita drift com o Zod usado no worker.
// O cast preserva os literais no tipo estático (o `.map` vira `TLiteral<string>[]`).
const categorySchema = t.Union(CATEGORIES.map((c) => t.Literal(c))) as TUnion<TLiteral<Category>[]>;

const partnerSchema = t.Union([
  t.Literal("quero-plantao"),
  t.Literal("inbram"),
  t.Literal("dgs"),
  t.Null(),
]);

const actionSchema = t.Union([t.Literal("allow"), t.Literal("remove"), t.Literal("ban")]);

const analysisSchema = t.Object({
  reason: t.String(),
  partner: partnerSchema,
  category: categorySchema,
  confidence: t.Number({ minimum: 0, maximum: 1 }),
  action: actionSchema,
});

const exampleSchema = t.Object({
  text: t.String({ minLength: 1 }),
  analysis: analysisSchema,
  note: t.Optional(t.String()),
});

// Response schema: `examples` e `escalationCategories` ficam como `unknown[]` no TypeBox
// porque o schema completo (com union de 12 literais aninhados em analysis) excede o
// limite de profundidade da inferência do Elysia e impede o handler de typecheckar.
// O shape real é validado na entrada (create body) e no service.
export const moderationConfigViewSchema = t.Object({
  id: t.String({ format: "uuid" }),
  version: t.String(),
  primaryModel: t.String(),
  escalationModel: t.Nullable(t.String()),
  escalationThreshold: t.Nullable(t.Number()),
  escalationCategories: t.Array(t.String()),
  systemPrompt: t.String(),
  examples: t.Array(t.Unknown()),
  contentHash: t.String(),
  isActive: t.Boolean(),
  activatedAt: t.Nullable(t.String({ format: "date-time" })),
  createdAt: t.String({ format: "date-time" }),
  updatedAt: t.String({ format: "date-time" }),
});

const createBodySchema = t.Object({
  version: t.String({ minLength: 1, maxLength: 100 }),
  primaryModel: t.String({ minLength: 1 }),
  escalationModel: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  escalationThreshold: t.Optional(t.Nullable(t.Number({ minimum: 0, maximum: 1 }))),
  escalationCategories: t.Optional(t.Array(categorySchema)),
  systemPrompt: t.String({ minLength: 1 }),
  examples: t.Optional(t.Array(exampleSchema, { maxItems: 50 })),
});

const listQuerySchema = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 10 })),
});

const versionParamSchema = t.Object({
  version: t.String({ minLength: 1 }),
});

export const activeResponseSchema = t.Object({
  data: moderationConfigViewSchema,
});

export const listResponseSchema = t.Object({
  data: t.Array(moderationConfigViewSchema),
});

export const createResponseSchema = t.Object({
  data: moderationConfigViewSchema,
});

export const activateResponseSchema = t.Object({
  data: moderationConfigViewSchema,
});

export const moderationConfigModel = new Elysia({ name: "moderationConfigModel" }).model({
  "moderationConfig.create.body": createBodySchema,
  "moderationConfig.list.query": listQuerySchema,
  "moderationConfig.version.params": versionParamSchema,
});
