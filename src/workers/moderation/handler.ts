import { ingestParticipantEvent } from "../../actions/whatsapp/ingest-participant-event.ts";
import {
  type ModerateFn,
  moderateGroupMessage,
} from "../../actions/whatsapp/moderate-group-message.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../../db/repositories/message-moderations-repository.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import type { GroupParticipantsService } from "../../services/group-participants/index.ts";
import type { ModerationEnforcementService } from "../../services/moderation-enforcement/index.ts";

export type ModerationExecuteDeps = {
  moderationsRepo: MessageModerationsRepository;
  groupMessagesRepo: GroupMessagesRepository;
  moderate: ModerateFn;
  enforcement: ModerationEnforcementService;
  participantsService: GroupParticipantsService;
};

export function createModerationExecuteJob(deps: ModerationExecuteDeps) {
  return async function executeJob(job: JobSchema): Promise<void> {
    switch (job.type) {
      case "whatsapp.moderate_group_message":
        return moderateGroupMessage(job.payload, {
          moderationsRepo: deps.moderationsRepo,
          groupMessagesRepo: deps.groupMessagesRepo,
          moderate: deps.moderate,
          enforcement: deps.enforcement,
        });
      case "whatsapp.ingest_participant_event":
        return ingestParticipantEvent(job.payload, {
          participantsService: deps.participantsService,
        });
      case "whatsapp.delete_message":
      case "whatsapp.remove_participant":
      case "whatsapp.join_group_via_invite":
        throw new NonRetryableError(
          `moderation-worker recebeu job ${job.type} (${job.id}) — routing quebrado`
        );
    }
  };
}
