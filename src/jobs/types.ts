export interface DeleteMessagePayload {
  messageId: string;
  phone: string;
  owner: boolean;
}

export interface RemoveParticipantPayload {
  groupId: string;
  phones: string[];
}

// Discriminated union — cada tipo de job carrega seu payload específico
export type Job =
  | {
      id: string;
      type: "delete_message";
      targetKey: string;
      payload: DeleteMessagePayload;
      createdAt: string;
      attempt?: number;
    }
  | {
      id: string;
      type: "remove_participant";
      targetKey: string;
      payload: RemoveParticipantPayload;
      createdAt: string;
      attempt?: number;
    };

export type JobType = Job["type"];
