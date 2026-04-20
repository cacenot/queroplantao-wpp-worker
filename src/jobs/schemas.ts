import { z } from "zod";

// `phone` é polimórfico: em grupo, carrega groupId (`"120363@g.us"`); em DM,
// carrega o phone do contato. É o campo "destino" exigido pela Z-API DELETE
// /messages — não segue a convenção E.164 do domínio.
const deleteMessagePayloadSchema = z.object({
  providerInstanceId: z.string().uuid(),
  messageId: z.string().min(1),
  phone: z.string().min(1),
  owner: z.boolean(),
});

const removeParticipantPayloadSchema = z.object({
  providerInstanceId: z.string().uuid(),
  groupId: z.string().min(1),
  phones: z
    .array(z.string().regex(/^\+\d{8,15}$/, "phone deve estar em E.164 (+DDIDDDNúmero)"))
    .min(1),
});

const moderateGroupMessagePayloadSchema = z.object({
  moderationId: z.string().uuid(),
});

const baseJobSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  attempt: z.number().int().nonnegative().optional(),
});

export const deleteMessageJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.delete_message"),
  payload: deleteMessagePayloadSchema,
});

export const removeParticipantJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.remove_participant"),
  payload: removeParticipantPayloadSchema,
});

export const moderateGroupMessageJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.moderate_group_message"),
  payload: moderateGroupMessagePayloadSchema,
});

export const jobSchema = z.discriminatedUnion("type", [
  deleteMessageJobSchema,
  removeParticipantJobSchema,
  moderateGroupMessageJobSchema,
]);

export type JobSchema = z.infer<typeof jobSchema>;
