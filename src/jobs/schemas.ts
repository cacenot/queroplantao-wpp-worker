import { z } from "zod";

// `phone` é polimórfico: em grupo, carrega groupId (`"120363@g.us"`); em DM,
// carrega o phone do contato. É o campo "destino" exigido pela Z-API DELETE
// /messages — não segue a convenção E.164 do domínio.
const deleteMessagePayloadSchema = z.object({
  providerInstanceId: z.guid(),
  messageId: z.string().min(1),
  phone: z.string().min(1),
  owner: z.boolean(),
});

const removeParticipantPayloadSchema = z.object({
  providerInstanceId: z.guid(),
  groupId: z.string().min(1),
  phones: z
    .array(z.string().regex(/^\+\d{8,15}$/, "phone deve estar em E.164 (+DDIDDDNúmero)"))
    .min(1),
});

const moderateGroupMessagePayloadSchema = z.object({
  moderationId: z.guid(),
});

const joinGroupViaInvitePayloadSchema = z.object({
  providerInstanceId: z.guid(),
  messagingGroupId: z.guid(),
  // Código puro do convite (último segmento do link `chat.whatsapp.com/<code>`).
  // A Z-API retorna `success: false` quando inválido/expirado — sem retry.
  inviteCode: z.string().min(1),
});

// `externalId` é polimórfico: groupId em group, phone E.164 em contact.
// Validação de E.164 fica no service (boundary) — aqui só garantimos não-vazio
// para tolerar grupos cujo formato pode variar entre providers.
const outboundTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), externalId: z.string().min(1) }),
  z.object({ kind: z.literal("contact"), externalId: z.string().min(1) }),
]);

const outboundButtonSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

const outboundContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("image"),
    imageUrl: z.string().url(),
    caption: z.string().optional(),
  }),
  z.object({
    kind: z.literal("video"),
    videoUrl: z.string().url(),
    caption: z.string().optional(),
  }),
  z.object({
    kind: z.literal("link"),
    message: z.string().min(1),
    linkUrl: z.string().url(),
    title: z.string().optional(),
    linkDescription: z.string().optional(),
    image: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal("location"),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    title: z.string().optional(),
    address: z.string().optional(),
  }),
  z.object({
    kind: z.literal("buttons"),
    message: z.string().min(1),
    buttons: z.array(outboundButtonSchema).min(1).max(3),
    title: z.string().optional(),
    footer: z.string().optional(),
  }),
]);

const sendMessagePayloadSchema = z.object({
  providerInstanceId: z.guid(),
  outboundMessageId: z.guid(),
  target: outboundTargetSchema,
  content: outboundContentSchema,
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
  providerInstanceId: z.guid().nullable(),
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
  id: z.guid(),
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

export const sendMessageJobSchema = baseJobSchema.extend({
  type: z.literal("whatsapp.send_message"),
  payload: sendMessagePayloadSchema,
});

export const jobSchema = z.discriminatedUnion("type", [
  deleteMessageJobSchema,
  removeParticipantJobSchema,
  moderateGroupMessageJobSchema,
  ingestParticipantEventJobSchema,
  joinGroupViaInviteJobSchema,
  sendMessageJobSchema,
]);

export type JobSchema = z.infer<typeof jobSchema>;
export type IngestParticipantEventPayload = z.infer<typeof participantEventPayloadSchema>;
export type JoinGroupViaInvitePayload = z.infer<typeof joinGroupViaInvitePayloadSchema>;
export type SendMessagePayload = z.infer<typeof sendMessagePayloadSchema>;
export type OutboundTarget = z.infer<typeof outboundTargetSchema>;
export type OutboundContent = z.infer<typeof outboundContentSchema>;
