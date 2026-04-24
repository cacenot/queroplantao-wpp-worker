import type { IngestParticipantEventPayload } from "../../jobs/schemas.ts";
import type { GroupParticipantsService } from "../../services/group-participants/index.ts";

type IngestParticipantEventDeps = {
  participantsService: GroupParticipantsService;
};

export async function ingestParticipantEvent(
  payload: IngestParticipantEventPayload,
  deps: IngestParticipantEventDeps
): Promise<void> {
  await deps.participantsService.applyEvent(payload);
}
