import { z } from "zod";

const deleteMessagePayloadSchema = z.object({
  messageId: z.string().min(1),
  phone: z.string().min(1),
  owner: z.boolean(),
});

const removeParticipantPayloadSchema = z.object({
  groupId: z.string().min(1),
  phones: z.array(z.string().min(1)).min(1),
});

const analyzeMessagePayloadSchema = z.object({
  hash: z.string().min(1),
  text: z.string().min(1),
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

export const analyzeMessageJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.analyze_message"),
  payload: analyzeMessagePayloadSchema,
});

export const jobSchema = z.discriminatedUnion("type", [
  deleteMessageJobSchema,
  removeParticipantJobSchema,
  analyzeMessageJobSchema,
]);

export type JobSchema = z.infer<typeof jobSchema>;
