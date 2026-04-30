import { z } from "zod";

const textMessageSchema = z.looseObject({
  message: z.string(),
});

const imageMessageSchema = z.looseObject({
  imageUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
});

const videoMessageSchema = z.looseObject({
  videoUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
});

const documentMessageSchema = z.looseObject({
  documentUrl: z.string().optional(),
  fileName: z.string().optional(),
  caption: z.string().optional(),
  mimeType: z.string().optional(),
  title: z.string().optional(),
  pageCount: z.number().optional(),
});

const audioMessageSchema = z.looseObject({
  audioUrl: z.string().optional(),
  mimeType: z.string().optional(),
  viewOnce: z.boolean().optional(),
});

const stickerMessageSchema = z.looseObject({
  stickerUrl: z.string().optional(),
  mimeType: z.string().optional(),
});

const contactMessageSchema = z.looseObject({
  displayName: z.string().optional(),
  vCard: z.string().optional(),
  phones: z.array(z.unknown()).optional(),
});

const locationMessageSchema = z.looseObject({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
});

const reactionMessageSchema = z.looseObject({
  value: z.string().optional(),
  reactionBy: z.string().optional(),
  referencedMessage: z
    .looseObject({
      messageId: z.string().optional(),
      fromMe: z.boolean().optional(),
    })
    .optional(),
});

const pollMessageSchema = z.looseObject({
  name: z.string().optional(),
  options: z.array(z.unknown()).optional(),
});

const listResponseMessageSchema = z.looseObject({
  message: z.string().optional(),
  title: z.string().optional(),
  selectedRowId: z.string().optional(),
});

const buttonsResponseMessageSchema = z.looseObject({
  message: z.string().optional(),
  buttonId: z.string().optional(),
});

const hydratedTemplateMessageSchema = z.looseObject({
  message: z.string().optional(),
  title: z.string().optional(),
  footer: z.string().optional(),
  buttons: z.array(z.unknown()).optional(),
});

const productMessageSchema = z.looseObject({});
const eventMessageSchema = z.looseObject({});

export const zapiReceivedWebhookSchema = z.looseObject({
  instanceId: z.string().optional(),
  messageId: z.string(),
  phone: z.string().optional(),
  connectedPhone: z.string().optional(),
  chatName: z.string().optional(),
  senderName: z.string().optional(),
  senderPhoto: z.string().nullish(),
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
  referenceMessageId: z.string().nullish(),
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
});

export type ZapiReceivedWebhookPayload = z.infer<typeof zapiReceivedWebhookSchema>;
