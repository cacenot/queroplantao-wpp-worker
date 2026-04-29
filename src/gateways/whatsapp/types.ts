import type { MessagingInstance, MessagingProvider, ProviderExecutor } from "../types.ts";
import type { ZApiGroupMetadata } from "./zapi/group-metadata-schema.ts";

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

export interface WhatsAppProvider extends MessagingProvider {
  readonly instance: WhatsAppInstance;
  deleteMessage(payload: DeleteMessagePayload): Promise<void>;
  removeParticipant(payload: RemoveParticipantPayload): Promise<{ value: boolean }>;
  fetchGroupMetadata(groupId: string): Promise<ZApiGroupMetadata>;
  acceptGroupInvite(inviteCode: string): Promise<AcceptGroupInviteResult>;
}

export type WhatsAppExecutor = ProviderExecutor<WhatsAppProvider>;
