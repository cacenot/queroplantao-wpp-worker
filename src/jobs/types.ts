import type { DeleteMessagePayload, RemoveParticipantPayload } from "../gateways/whatsapp/types.ts";
import type { IngestParticipantEventPayload } from "./schemas.ts";

export type { DeleteMessagePayload, RemoveParticipantPayload };

export interface ModerateGroupMessagePayload {
  moderationId: string;
}

export type Job =
  | {
      id: string;
      type: "whatsapp.delete_message";
      payload: DeleteMessagePayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "whatsapp.remove_participant";
      payload: RemoveParticipantPayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "whatsapp.moderate_group_message";
      payload: ModerateGroupMessagePayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "whatsapp.ingest_participant_event";
      payload: IngestParticipantEventPayload;
      createdAt: string;
      attempt?: number;
    };

export type JobType = Job["type"];
