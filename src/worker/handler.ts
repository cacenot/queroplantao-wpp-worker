import type { AsyncMessage, Publisher } from "rabbitmq-client";
import { ConsumerStatus } from "rabbitmq-client";
import { analyzeMessage } from "../actions/whatsapp/analyze-message.ts";
import { deleteMessage } from "../actions/whatsapp/delete-message.ts";
import { moderateGroupMessage } from "../actions/whatsapp/moderate-group-message.ts";
import { removeParticipant } from "../actions/whatsapp/remove-participant.ts";
import type { MessageAnalysis } from "../ai/moderator.ts";
import type { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { jobSchema } from "../jobs/schemas.ts";
import { NonRetryableError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import type { RetryTopology } from "../lib/retry-topology.ts";
import type { GatewayRegistry } from "../messaging/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../messaging/whatsapp/types.ts";
import type { TaskService } from "../services/task/index.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;

interface JobHandlerOptions {
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  classifyMessage: ClassifyFn;
  adminApi: QpAdminApiClient;
  taskService: TaskService;
  moderationsRepo: MessageModerationsRepository;
  groupMessagesRepo: GroupMessagesRepository;
  publisher: Publisher;
  topology: RetryTopology;
  onSuccess?: () => void;
}

function resolveExecutor(
  registry: GatewayRegistry<WhatsAppProvider>,
  providerInstanceId: string
): WhatsAppExecutor {
  const executor = registry.getByInstanceId(providerInstanceId);
  if (!executor) {
    throw new NonRetryableError(`Provider instance desconhecido no worker: ${providerInstanceId}`);
  }
  return executor;
}

export function createJobHandler(options: JobHandlerOptions) {
  const {
    whatsappGatewayRegistry,
    classifyMessage,
    adminApi,
    taskService,
    moderationsRepo,
    groupMessagesRepo,
    publisher,
    topology,
    onSuccess,
  } = options;

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

    // attempt reflete o contador APÓS incremento do claimForExecution (começa em 1).
    // No fallback, confia no campo attempt da mensagem (melhor estimativa disponível).
    const attemptNumber = claimed === "fallback" ? (job.attempt ?? 1) : claimed.attempt;

    jobLog.info({ attempt: attemptNumber }, "Job recebido — executando");

    try {
      switch (job.type) {
        case "whatsapp.delete_message":
          await deleteMessage(
            job.payload,
            resolveExecutor(whatsappGatewayRegistry, job.payload.providerInstanceId)
          );
          break;
        case "whatsapp.remove_participant":
          await removeParticipant(
            job.payload,
            resolveExecutor(whatsappGatewayRegistry, job.payload.providerInstanceId)
          );
          break;
        case "whatsapp.analyze_message":
          await analyzeMessage(job.payload, classifyMessage, adminApi);
          break;
        case "whatsapp.moderate_group_message":
          await moderateGroupMessage(job.payload, {
            moderationsRepo,
            groupMessagesRepo,
            classify: classifyMessage,
          });
          break;
      }

      jobLog.info("Job concluído com sucesso");
      await taskService.markSucceeded(job.id).catch((err) => {
        jobLog.warn({ err }, "Falha ao marcar task succeeded — job já executado");
      });
      onSuccess?.();
    } catch (err) {
      const isNonRetryable = err instanceof NonRetryableError;
      const retriesUsed = attemptNumber - 1;
      const canRetry = !isNonRetryable && retriesUsed < topology.maxRetries;

      if (canRetry) {
        jobLog.warn(
          { err, attempt: attemptNumber, retryQueue: topology.retryQueue },
          "Erro ao executar job — agendando retry"
        );

        try {
          await publisher.send(
            // `durable: true` no publisher.send é o alias do rabbitmq-client para
            // deliveryMode=2 (mensagem persistente — sobrevive a restart do broker)
            { routingKey: topology.retryQueue, durable: true },
            { ...job, attempt: attemptNumber }
          );
          await taskService.markRetrying(job.id).catch((e) => {
            jobLog.warn({ err: e }, "Falha ao marcar task retrying — status pode ficar running");
          });
        } catch (publishErr) {
          // Não conseguiu publicar na retry queue: requeue da mensagem original
          // para não perder o job. claimForExecution aceita status `running` para
          // cobrir este cenário e reexecutar na redelivery.
          jobLog.error(
            { publishErr, attempt: attemptNumber },
            "Falha ao publicar no retry queue — requeuing mensagem original"
          );
          await taskService.markRetrying(job.id).catch((e) => {
            jobLog.warn({ err: e }, "markRetrying falhou durante REQUEUE");
          });
          return ConsumerStatus.REQUEUE;
        }

        return ConsumerStatus.DROP;
      }

      // NonRetryableError ou retries esgotados → DLQ
      const reason = isNonRetryable ? "non_retryable" : "max_retries_exceeded";

      jobLog.error({ err, attempt: attemptNumber, reason }, "Enviando job para DLQ");

      try {
        await publisher.send(
          { routingKey: topology.dlqName, durable: true },
          { ...job, attempt: attemptNumber }
        );
      } catch (publishErr) {
        jobLog.error({ publishErr }, "Falha ao publicar no DLQ — requeuing mensagem original");
        await taskService.markRetrying(job.id).catch((e) => {
          jobLog.warn({ err: e }, "markRetrying falhou durante REQUEUE");
        });
        return ConsumerStatus.REQUEUE;
      }

      await taskService.markFailed(job.id, err).catch((e) => {
        jobLog.warn({ err: e }, "Falha ao marcar task failed");
      });
      return ConsumerStatus.DROP;
    }

    return undefined;
  };
}
