import type {
  DeleteMessagePayload,
  RemoveParticipantPayload,
} from "../messaging/whatsapp/types.ts";

export type { DeleteMessagePayload, RemoveParticipantPayload };

export interface AnalyzeMessagePayload {
  hash: string;
  text: string;
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
      type: "whatsapp.analyze_message";
      payload: AnalyzeMessagePayload;
      createdAt: string;
      attempt?: number;
    };

export type JobType = Job["type"];
