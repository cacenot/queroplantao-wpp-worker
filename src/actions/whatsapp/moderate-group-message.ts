import type { ClassifyResult } from "../../ai/classify-tiered.ts";
import type { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../../db/repositories/message-moderations-repository.ts";
import type { ModerateGroupMessagePayload } from "../../jobs/types.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";

export type ModerateFn = (text: string) => Promise<ClassifyResult>;

export interface ModerateGroupMessageDeps {
  moderationsRepo: MessageModerationsRepository;
  groupMessagesRepo: GroupMessagesRepository;
  moderate: ModerateFn;
}

export async function moderateGroupMessage(
  payload: ModerateGroupMessagePayload,
  deps: ModerateGroupMessageDeps
): Promise<void> {
  const { moderationsRepo, groupMessagesRepo, moderate } = deps;

  const record = await moderationsRepo.findByIdWithMessage(payload.moderationId);
  if (!record) {
    throw new NonRetryableError(`Moderation ${payload.moderationId} não encontrada`);
  }

  if (record.moderation.status !== "pending") {
    // Idempotente: outra execução (redelivery) já concluiu.
    logger.info(
      { moderationId: payload.moderationId, status: record.moderation.status },
      "Moderation já terminal — skip"
    );
    return;
  }

  const text = record.message.normalizedText ?? record.message.caption ?? "";
  if (!text) {
    throw new NonRetryableError(
      `Moderation ${payload.moderationId}: mensagem sem texto para moderar`
    );
  }

  const start = performance.now();

  try {
    const result = await moderate(text);
    const latency = Math.round(performance.now() - start);
    const { analysis, modelUsed } = result;

    await moderationsRepo.markAnalyzed(payload.moderationId, {
      model: modelUsed,
      reason: analysis.reason,
      partner: analysis.partner,
      category: analysis.category,
      confidence: analysis.confidence,
      action: analysis.action,
      rawResult: buildRawResult(result),
      promptTokens: null,
      completionTokens: null,
      latencyMs: latency,
    });

    await groupMessagesRepo.setModerationStatus(record.message.id, "analyzed");
  } catch (err) {
    // Só persiste falha em erros terminais. Erros transientes ficam com
    // status='pending' para o retry AMQP re-executar a classificação.
    if (err instanceof NonRetryableError) {
      const latency = Math.round(performance.now() - start);
      const error =
        err instanceof Error
          ? { message: err.message, name: err.name, stack: err.stack }
          : { message: String(err) };
      await moderationsRepo.markFailed(payload.moderationId, error, latency);
      await groupMessagesRepo.setModerationStatus(record.message.id, "failed");
    }
    throw err;
  }
}

export function buildRawResult(result: ClassifyResult): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    analysis: result.analysis,
    escalated: result.escalated,
  };
  if (result.primaryAnalysis) raw.primaryAnalysis = result.primaryAnalysis;
  return raw;
}
