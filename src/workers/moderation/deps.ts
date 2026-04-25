import type { ModerateFn } from "../../actions/whatsapp/moderate-group-message.ts";
import { classifyTiered } from "../../ai/classify-tiered.ts";
import { createModelRegistry } from "../../ai/model-registry.ts";
import { loadActive } from "../../ai/moderation/loader.ts";
import { env } from "../../config/env.ts";
import { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import { GroupParticipantsRepository } from "../../db/repositories/group-participants-repository.ts";
import { MessageModerationsRepository } from "../../db/repositories/message-moderations-repository.ts";
import { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import { PhonePoliciesRepository } from "../../db/repositories/phone-policies-repository.ts";
import { logger } from "../../lib/logger.ts";
import { ContentFilterService } from "../../services/content-filter/index.ts";
import { GroupParticipantsService } from "../../services/group-participants/index.ts";
import { ModerationEnforcementService } from "../../services/moderation-enforcement/index.ts";
import { PhonePoliciesService } from "../../services/phone-policies/index.ts";
import { buildSharedDeps, type SharedDeps } from "../shared/build-shared-deps.ts";

export type ModerationWorkerDeps = SharedDeps & {
  moderationsRepo: MessageModerationsRepository;
  groupMessagesRepo: GroupMessagesRepository;
  enforcement: ModerationEnforcementService;
  moderate: ModerateFn;
  participantsService: GroupParticipantsService;
};

export async function buildModerationWorkerDeps(): Promise<ModerationWorkerDeps> {
  const shared = await buildSharedDeps();

  const moderationsRepo = new MessageModerationsRepository(shared.db);
  const groupMessagesRepo = new GroupMessagesRepository(shared.db);
  const phonePoliciesRepo = new PhonePoliciesRepository(shared.db);
  const messagingGroupsRepo = new MessagingGroupsRepository(shared.db);
  const groupParticipantsRepo = new GroupParticipantsRepository(shared.db);

  const phonePoliciesService = new PhonePoliciesService({ repo: phonePoliciesRepo });
  const contentFilter = new ContentFilterService();
  const enforcement = new ModerationEnforcementService({
    phonePoliciesService,
    taskService: shared.taskService,
    redis: shared.redis,
    logger,
    contentFilter,
    contentFilterEnabled: env.MODERATION_CONTENT_FILTER_ENABLED,
    blacklistEnforcementEnabled: env.MODERATION_BLACKLIST_ENFORCEMENT_ENABLED,
  });

  const participantsService = new GroupParticipantsService({
    repo: groupParticipantsRepo,
    messagingGroupsRepo,
  });

  // Config de moderação é arquivo .md versionado em `src/ai/moderation/versions/`.
  // Troca exige redeploy — sem hot-reload (rollback via git revert).
  const moderationConfig = loadActive();

  // Registry memoiza LanguageModel por string.
  const modelRegistry = createModelRegistry();

  const moderate: ModerateFn = (text) =>
    classifyTiered(text, {
      primaryModel: modelRegistry.getModel(moderationConfig.primaryModel),
      primaryModelString: moderationConfig.primaryModel,
      escalationModel: moderationConfig.escalationModel
        ? modelRegistry.getModel(moderationConfig.escalationModel)
        : null,
      escalationModelString: moderationConfig.escalationModel,
      escalationThreshold: moderationConfig.escalationThreshold,
      escalationCategories: moderationConfig.escalationCategories,
      systemPrompt: moderationConfig.systemPrompt,
      examples: moderationConfig.examples,
    });

  return {
    ...shared,
    moderationsRepo,
    groupMessagesRepo,
    enforcement,
    moderate,
    participantsService,
  };
}
