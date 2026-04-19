import type { MessagingInstance, MessagingProvider, ProviderExecutor } from "../types.ts";

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

export interface WhatsAppProvider extends MessagingProvider {
  readonly instance: WhatsAppInstance;
  deleteMessage(payload: DeleteMessagePayload): Promise<void>;
  removeParticipant(payload: RemoveParticipantPayload): Promise<{ value: boolean }>;
}

export type WhatsAppExecutor = ProviderExecutor<WhatsAppProvider>;
