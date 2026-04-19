import { z } from "zod";

const deleteMessagePayloadSchema = z.object({
  providerInstanceId: z.string().uuid(),
  messageId: z.string().min(1),
  phone: z.string().min(1),
  owner: z.boolean(),
});

const removeParticipantPayloadSchema = z.object({
  providerInstanceId: z.string().uuid(),
  groupId: z.string().min(1),
  phones: z.array(z.string().min(1)).min(1),
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
