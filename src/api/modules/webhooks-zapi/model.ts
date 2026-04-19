import { Elysia, t } from "elysia";

const ignoredSchema = t.Object({
  status: t.Literal("ignored"),
  reason: t.String(),
});

const duplicateSchema = t.Object({
  status: t.Literal("duplicate"),
  messageId: t.String(),
});

const queuedSchema = t.Object({
  status: t.Literal("queued"),
  messageId: t.String(),
  moderationId: t.String(),
});

const reusedSchema = t.Object({
  status: t.Literal("reused"),
  messageId: t.String(),
  moderationId: t.String(),
  sourceModerationId: t.String(),
});

export const webhooksZapiModel = new Elysia({ name: "webhooksZapiModel" }).model({
  "webhooksZapi.ingest.response": t.Union([
    ignoredSchema,
    duplicateSchema,
    queuedSchema,
    reusedSchema,
  ]),
});

export { zapiReceivedWebhookSchema } from "../../../gateways/whatsapp/zapi/webhook-schema.ts";
