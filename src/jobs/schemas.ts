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

// Schema base compartilhado por todos os tipos de job
const baseJobSchema = z.object({
  id: z.string().min(1),
  targetKey: z.string().min(1),
  createdAt: z.string().datetime(),
  attempt: z.number().int().nonnegative().optional(),
});

export const deleteMessageJobSchema = baseJobSchema.extend({
  type: z.literal("delete_message"),
  payload: deleteMessagePayloadSchema,
});

export const removeParticipantJobSchema = baseJobSchema.extend({
  type: z.literal("remove_participant"),
  payload: removeParticipantPayloadSchema,
});

// Schema raiz — faz discriminação pelo campo `type`
export const jobSchema = z.discriminatedUnion("type", [
  deleteMessageJobSchema,
  removeParticipantJobSchema,
]);

export type JobSchema = z.infer<typeof jobSchema>;
