import type { AsyncMessage } from "rabbitmq-client";
import { ConsumerStatus } from "rabbitmq-client";
import { analyzeMessage } from "../actions/whatsapp/analyze-message.ts";
import { deleteMessage } from "../actions/whatsapp/delete-message.ts";
import { removeParticipant } from "../actions/whatsapp/remove-participant.ts";
import type { MessageAnalysis } from "../ai/moderator.ts";
import { jobSchema } from "../jobs/schemas.ts";
import { logger } from "../lib/logger.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import type { WhatsAppExecutor } from "../messaging/whatsapp/types.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;

interface JobHandlerOptions {
  whatsappGateway: WhatsAppExecutor;
  classifyMessage: ClassifyFn;
  adminApi: QpAdminApiClient;
  onSuccess?: () => void;
}

export function createJobHandler(options: JobHandlerOptions) {
  const { whatsappGateway, classifyMessage, adminApi, onSuccess } = options;

  return async function handleMessage(msg: AsyncMessage): Promise<ConsumerStatus | undefined> {
    const parseResult = jobSchema.safeParse(msg.body);
    if (!parseResult.success) {
      logger.error(
        { errors: parseResult.error.flatten() },
        "Job com schema inválido — descartando"
      );
      return ConsumerStatus.DROP;
    }

    const job = parseResult.data;
    const jobLog = logger.child({ jobId: job.id, type: job.type });

    jobLog.info("Job recebido — executando");

    try {
      switch (job.type) {
        case "whatsapp.delete_message":
          await deleteMessage(job.payload, whatsappGateway);
          break;
        case "whatsapp.remove_participant":
          await removeParticipant(job.payload, whatsappGateway);
          break;
        case "whatsapp.analyze_message":
          await analyzeMessage(job.payload, classifyMessage, adminApi);
          break;
      }

      jobLog.info("Job concluído com sucesso");
      onSuccess?.();
    } catch (err) {
      jobLog.error({ err, attempt: job.attempt }, "Erro ao executar job");
      // TODO: incrementar attempt e publicar na DLQ para retry controlado
      return ConsumerStatus.DROP;
    }

    return undefined;
  };
}
