export interface DeleteMessagePayload {
  messageId: string;
  phone: string;
  owner: boolean;
}

export interface RemoveParticipantPayload {
  groupId: string;
  phones: string[];
}

export interface AnalyzeMessagePayload {
  hash: string;
  text: string;
}

// Discriminated union — cada tipo de job carrega seu payload específico
export type Job =
  | {
      id: string;
      type: "delete_message";
      payload: DeleteMessagePayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "remove_participant";
      payload: RemoveParticipantPayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "analyze_message";
      payload: AnalyzeMessagePayload;
      createdAt: string;
      attempt?: number;
    };

export type JobType = Job["type"];
