import type { Logger } from "pino";
import type { AsyncMessage, Publisher } from "rabbitmq-client";
import { ConsumerStatus } from "rabbitmq-client";
import { analyzeMessage } from "../actions/whatsapp/analyze-message.ts";
import { deleteMessage } from "../actions/whatsapp/delete-message.ts";
import { moderateGroupMessage } from "../actions/whatsapp/moderate-group-message.ts";
import { removeParticipant } from "../actions/whatsapp/remove-participant.ts";
import type { MessageAnalysis } from "../ai/moderator.ts";
import type { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import { type JobSchema, jobSchema } from "../jobs/schemas.ts";
import { NonRetryableError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import type { RetryTopology } from "../lib/retry-topology.ts";
import type { GatewayRegistry } from "../messaging/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../messaging/whatsapp/types.ts";
import type { TaskService } from "../services/task/index.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;
type JobLogger = Logger;

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

interface ExecuteDeps {
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  classifyMessage: ClassifyFn;
  adminApi: QpAdminApiClient;
  moderationsRepo: MessageModerationsRepository;
  groupMessagesRepo: GroupMessagesRepository;
}

interface PublishDeps {
  publisher: Publisher;
  taskService: TaskService;
  jobLog: JobLogger;
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

async function executeJob(job: JobSchema, deps: ExecuteDeps): Promise<void> {
  switch (job.type) {
    case "whatsapp.delete_message":
      return deleteMessage(
        job.payload,
        resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId)
      );
    case "whatsapp.remove_participant":
      return removeParticipant(
        job.payload,
        resolveExecutor(deps.whatsappGatewayRegistry, job.payload.providerInstanceId)
      );
    case "whatsapp.analyze_message":
      return analyzeMessage(job.payload, deps.classifyMessage, deps.adminApi);
    case "whatsapp.moderate_group_message":
      return moderateGroupMessage(job.payload, {
        moderationsRepo: deps.moderationsRepo,
        groupMessagesRepo: deps.groupMessagesRepo,
        classify: deps.classifyMessage,
      });
  }
}

// `durable: true` é o alias do rabbitmq-client para deliveryMode=2
// (mensagem persistente — sobrevive a restart do broker).
async function publishOrRequeue(
  deps: PublishDeps,
  args: {
    queue: string;
    job: JobSchema;
    attempt: number;
    onPublished: () => Promise<unknown>;
  }
): Promise<ConsumerStatus> {
  try {
    await deps.publisher.send(
      { routingKey: args.queue, durable: true },
      { ...args.job, attempt: args.attempt }
    );
    await args.onPublished();
    return ConsumerStatus.DROP;
  } catch (publishErr) {
    deps.jobLog.error(
      { publishErr, queue: args.queue, attempt: args.attempt },
      "Falha ao publicar — requeuing mensagem original"
    );
    await deps.taskService.markRetrying(args.job.id).catch((e) => {
      deps.jobLog.warn({ err: e }, "markRetrying falhou durante REQUEUE");
    });
    return ConsumerStatus.REQUEUE;
  }
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

  const executeDeps: ExecuteDeps = {
    whatsappGatewayRegistry,
    classifyMessage,
    adminApi,
    moderationsRepo,
    groupMessagesRepo,
  };

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
      await executeJob(job, executeDeps);

      jobLog.info("Job concluído com sucesso");
      await taskService.markSucceeded(job.id).catch((err) => {
        jobLog.warn({ err }, "Falha ao marcar task succeeded — job já executado");
      });
      onSuccess?.();
      return undefined;
    } catch (err) {
      const isNonRetryable = err instanceof NonRetryableError;
      const retriesUsed = attemptNumber - 1;
      const canRetry = !isNonRetryable && retriesUsed < topology.maxRetries;
      const publishDeps: PublishDeps = { publisher, taskService, jobLog };

      if (canRetry) {
        jobLog.warn(
          { err, attempt: attemptNumber, retryQueue: topology.retryQueue },
          "Erro ao executar job — agendando retry"
        );
        return publishOrRequeue(publishDeps, {
          queue: topology.retryQueue,
          job,
          attempt: attemptNumber,
          onPublished: () =>
            taskService.markRetrying(job.id).catch((e) => {
              jobLog.warn({ err: e }, "Falha ao marcar task retrying — status pode ficar running");
            }),
        });
      }

      // NonRetryableError ou retries esgotados → DLQ
      const reason = isNonRetryable ? "non_retryable" : "max_retries_exceeded";
      jobLog.error({ err, attempt: attemptNumber, reason }, "Enviando job para DLQ");

      return publishOrRequeue(publishDeps, {
        queue: topology.dlqName,
        job,
        attempt: attemptNumber,
        onPublished: () =>
          taskService.markFailed(job.id, err).catch((e) => {
            jobLog.warn({ err: e }, "Falha ao marcar task failed");
          }),
      });
    }
  };
}
