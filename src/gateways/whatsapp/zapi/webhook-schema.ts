import { z } from "zod";

const textMessageSchema = z
  .object({
    message: z.string(),
  })
  .passthrough();

const imageMessageSchema = z
  .object({
    imageUrl: z.string().optional(),
    thumbnailUrl: z.string().optional(),
    caption: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

const videoMessageSchema = z
  .object({
    videoUrl: z.string().optional(),
    thumbnailUrl: z.string().optional(),
    caption: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

const documentMessageSchema = z
  .object({
    documentUrl: z.string().optional(),
    fileName: z.string().optional(),
    caption: z.string().optional(),
    mimeType: z.string().optional(),
    title: z.string().optional(),
    pageCount: z.number().optional(),
  })
  .passthrough();

const audioMessageSchema = z
  .object({
    audioUrl: z.string().optional(),
    mimeType: z.string().optional(),
    viewOnce: z.boolean().optional(),
  })
  .passthrough();

const stickerMessageSchema = z
  .object({
    stickerUrl: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

const contactMessageSchema = z
  .object({
    displayName: z.string().optional(),
    vCard: z.string().optional(),
    phones: z.array(z.unknown()).optional(),
  })
  .passthrough();

const locationMessageSchema = z
  .object({
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    address: z.string().optional(),
    name: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const reactionMessageSchema = z
  .object({
    value: z.string().optional(),
    reactionBy: z.string().optional(),
    referencedMessage: z
      .object({
        messageId: z.string().optional(),
        fromMe: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const pollMessageSchema = z
  .object({
    name: z.string().optional(),
    options: z.array(z.unknown()).optional(),
  })
  .passthrough();

const listResponseMessageSchema = z
  .object({
    message: z.string().optional(),
    title: z.string().optional(),
    selectedRowId: z.string().optional(),
  })
  .passthrough();

const buttonsResponseMessageSchema = z
  .object({
    message: z.string().optional(),
    buttonId: z.string().optional(),
  })
  .passthrough();

const hydratedTemplateMessageSchema = z
  .object({
    message: z.string().optional(),
    title: z.string().optional(),
    footer: z.string().optional(),
    buttons: z.array(z.unknown()).optional(),
  })
  .passthrough();

const productMessageSchema = z.object({}).passthrough();
const eventMessageSchema = z.object({}).passthrough();

export const zapiReceivedWebhookSchema = z
  .object({
    instanceId: z.string().optional(),
    messageId: z.string(),
    phone: z.string().optional(),
    connectedPhone: z.string().optional(),
    chatName: z.string().optional(),
    senderName: z.string().optional(),
    senderPhoto: z.string().optional(),
    participantPhone: z.string().nullish(),
    participantLid: z.string().nullish(),
    fromMe: z.boolean().optional(),
    isGroup: z.boolean().optional(),
    isNewsletter: z.boolean().optional(),
    broadcast: z.boolean().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    notification: z.string().optional(),
    notificationParameters: z.array(z.string()).optional(),
    requestMethod: z.string().optional(),
    waitingMessage: z.boolean().optional(),
    viewOnce: z.boolean().optional(),
    forwarded: z.boolean().optional(),
    isEdit: z.boolean().optional(),
    fromApi: z.boolean().optional(),
    momment: z.number().optional(),
    referenceMessageId: z.string().optional(),
    text: textMessageSchema.optional(),
    image: imageMessageSchema.optional(),
    video: videoMessageSchema.optional(),
    audio: audioMessageSchema.optional(),
    document: documentMessageSchema.optional(),
    sticker: stickerMessageSchema.optional(),
    contact: contactMessageSchema.optional(),
    location: locationMessageSchema.optional(),
    reaction: reactionMessageSchema.optional(),
    poll: pollMessageSchema.optional(),
    listResponseMessage: listResponseMessageSchema.optional(),
    buttonsResponseMessage: buttonsResponseMessageSchema.optional(),
    hydratedTemplate: hydratedTemplateMessageSchema.optional(),
    product: productMessageSchema.optional(),
    event: eventMessageSchema.optional(),
  })
  .passthrough();

export type ZapiReceivedWebhookPayload = z.infer<typeof zapiReceivedWebhookSchema>;
