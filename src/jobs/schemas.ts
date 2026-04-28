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

const joinGroupViaInvitePayloadSchema = z.object({
  providerInstanceId: z.string().uuid(),
  messagingGroupId: z.string().uuid(),
  // Código puro do convite (último segmento do link `chat.whatsapp.com/<code>`).
  // A Z-API retorna `success: false` quando inválido/expirado — sem retry.
  inviteCode: z.string().min(1),
});

// `joined_inferred` só existe como event_type no DB para futuras
// extensões — hoje a inferência via mensagem usa `recordSeenFromMessage` no
// service e não gera row em `group_participant_events`. Se um dia voltar a
// gerar, adicionar o literal aqui.
const participantEventTypeSchema = z.enum([
  "joined_add",
  "joined_invite_link",
  "joined_non_admin_add",
  "left_removed",
  "left_voluntary",
  "promoted_admin",
  "demoted_member",
]);

const participantIdentifierSchema = z.object({
  phone: z.string().nullable(),
  senderExternalId: z.string().nullable(),
});

const participantEventPayloadSchema = z.object({
  providerInstanceId: z.string().uuid().nullable(),
  event: z.object({
    providerKind: z.literal("whatsapp_zapi"),
    protocol: z.literal("whatsapp"),
    groupExternalId: z.string().min(1),
    eventType: participantEventTypeSchema,
    targets: z.array(participantIdentifierSchema).min(1),
    actor: participantIdentifierSchema.nullable(),
    displayName: z.string().nullable(),
    occurredAt: z.string().datetime(),
    sourceWebhookMessageId: z.string(),
    sourceNotification: z.string(),
    rawPayload: z.unknown(),
  }),
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

export const ingestParticipantEventJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.ingest_participant_event"),
  payload: participantEventPayloadSchema,
});

export const joinGroupViaInviteJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.join_group_via_invite"),
  payload: joinGroupViaInvitePayloadSchema,
});

export const jobSchema = z.discriminatedUnion("type", [
  deleteMessageJobSchema,
  removeParticipantJobSchema,
  moderateGroupMessageJobSchema,
  ingestParticipantEventJobSchema,
  joinGroupViaInviteJobSchema,
]);

export type JobSchema = z.infer<typeof jobSchema>;
export type IngestParticipantEventPayload = z.infer<typeof participantEventPayloadSchema>;
export type JoinGroupViaInvitePayload = z.infer<typeof joinGroupViaInvitePayloadSchema>;
