import { t } from "elysia";

export const errorResponseSchema = t.Object({
  error: t.String(),
  details: t.Optional(t.Unknown()),
});
