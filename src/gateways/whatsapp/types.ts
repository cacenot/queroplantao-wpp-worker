import type { MessagingInstance, MessagingProvider, ProviderExecutor } from "../types.ts";
import type { ZApiGroupMetadataLight } from "./zapi/group-metadata-schema.ts";

export interface WhatsAppInstance extends MessagingInstance {}

export interface DeleteMessagePayload {
  messageId: string;
  phone: string;
  owner: boolean;
}

export interface RemoveParticipantPayload {
  groupId: string;
  phones: string[];
}

export interface AcceptGroupInviteResult {
  success: boolean;
  raw: unknown;
}

// Targets de envio. `externalId` é polimórfico:
// - group: groupId no formato do provider (ex.: `120363...@g.us` para Z-API).
// - contact: phone E.164 (ex.: `+5547997490248`). Conversão para o formato
//   exigido pelo provider acontece dentro do client (ex.: `toZapiDigits`).
export type SendTarget =
  | { kind: "group"; externalId: string }
  | { kind: "contact"; externalId: string };

export interface SendTextPayload {
  target: SendTarget;
  message: string;
}

export interface SendImagePayload {
  target: SendTarget;
  imageUrl: string;
  caption?: string;
}

export interface SendVideoPayload {
  target: SendTarget;
  videoUrl: string;
  caption?: string;
}

export interface SendLinkPayload {
  target: SendTarget;
  message: string;
  linkUrl: string;
  title?: string;
  linkDescription?: string;
  image?: string;
}

export interface SendLocationPayload {
  target: SendTarget;
  latitude: number;
  longitude: number;
  title?: string;
  address?: string;
}

export interface SendButton {
  id: string;
  label: string;
}

export interface SendButtonsPayload {
  target: SendTarget;
  message: string;
  buttons: SendButton[];
  title?: string;
  footer?: string;
}

export interface SendResult {
  externalMessageId: string;
  raw: unknown;
}

export interface WhatsAppProvider extends MessagingProvider {
  readonly instance: WhatsAppInstance;
  deleteMessage(payload: DeleteMessagePayload): Promise<void>;
  removeParticipant(payload: RemoveParticipantPayload): Promise<{ value: boolean }>;
  fetchGroupMetadataLight(groupId: string): Promise<ZApiGroupMetadataLight>;
  acceptGroupInvite(inviteCode: string): Promise<AcceptGroupInviteResult>;
  sendText(payload: SendTextPayload): Promise<SendResult>;
  sendImage(payload: SendImagePayload): Promise<SendResult>;
  sendVideo(payload: SendVideoPayload): Promise<SendResult>;
  sendLink(payload: SendLinkPayload): Promise<SendResult>;
  sendLocation(payload: SendLocationPayload): Promise<SendResult>;
  sendButtons(payload: SendButtonsPayload): Promise<SendResult>;
}

export type WhatsAppExecutor = ProviderExecutor<WhatsAppProvider>;
