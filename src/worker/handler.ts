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
import type { TaskService } from "../services/task/index.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;

interface JobHandlerOptions {
  whatsappGateway: WhatsAppExecutor;
  classifyMessage: ClassifyFn;
  adminApi: QpAdminApiClient;
  taskService: TaskService;
  onSuccess?: () => void;
}

export function createJobHandler(options: JobHandlerOptions) {
  const { whatsappGateway, classifyMessage, adminApi, taskService, onSuccess } = options;

  return async function handleMessage(msg: AsyncMessage): Promise<ConsumerStatus | undefined> {
    const parseResult = jobSchema.safeParse(msg.body);
    if (!parseResult.success) {
      logger.error(
        { errors: parseResult.error.flatten() },
        "Job com schema inválido — descartando"
      );

      const maybeId = (msg.body as Record<string, unknown>)?.id;
      if (typeof maybeId === "string") {
        await taskService.markDropped(maybeId, "schema_invalid").catch(() => {});
      }

      return ConsumerStatus.DROP;
    }

    const job = parseResult.data;
    const jobLog = logger.child({ jobId: job.id, type: job.type });

    const claimed = await taskService.claimForExecution(job.id).catch((err) => {
      jobLog.warn({ err }, "Falha ao reivindicar task — executando sem persistência");
      return "fallback" as const;
    });

    if (claimed === null) {
      jobLog.warn("Task já terminal ou inexistente — DROP (redelivery)");
      return ConsumerStatus.DROP;
    }

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
      await taskService.markSucceeded(job.id).catch((err) => {
        jobLog.warn({ err }, "Falha ao marcar task succeeded — job já executado");
      });
      onSuccess?.();
    } catch (err) {
      jobLog.error({ err, attempt: job.attempt }, "Erro ao executar job");
      await taskService.markFailed(job.id, err).catch((e) => {
        jobLog.warn({ err: e }, "Falha ao marcar task failed");
      });
      return ConsumerStatus.DROP;
    }

    return undefined;
  };
}
