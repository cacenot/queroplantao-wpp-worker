import { t } from "elysia";

export const enqueueResponseSchema = t.Object({
  accepted: t.Integer(),
  duplicates: t.Integer(),
});

export const enqueueErrorResponseSchema = t.Object({
  error: t.String(),
  details: t.Optional(t.Unknown()),
});
