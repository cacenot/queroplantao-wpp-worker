import type { Logger } from "pino";
import type { AsyncMessage, Publisher } from "rabbitmq-client";
import { ConsumerStatus } from "rabbitmq-client";
import { z } from "zod";
import { analyzeMessage } from "../actions/whatsapp/analyze-message.ts";
import { deleteMessage } from "../actions/whatsapp/delete-message.ts";
import { moderateGroupMessage } from "../actions/whatsapp/moderate-group-message.ts";
import { removeParticipant } from "../actions/whatsapp/remove-participant.ts";
import type { MessageAnalysis } from "../ai/moderator.ts";
import type { GroupMessagesRepository } from "../db/repositories/group-messages-repository.ts";
import type { MessageModerationsRepository } from "../db/repositories/message-moderations-repository.ts";
import type { GatewayRegistry } from "../gateways/gateway-registry.ts";
import type { WhatsAppExecutor, WhatsAppProvider } from "../gateways/whatsapp/types.ts";
import { type JobSchema, jobSchema } from "../jobs/schemas.ts";
import { NonRetryableError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import type { RetryTopology } from "../lib/retry-topology.ts";
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

function warnOnFail(log: JobLogger, message: string) {
  return (err: unknown) => log.warn({ err }, message);
}

// Retorna { attempt } quando o job deve executar (claim no DB ou fallback sem
// persistência se o DB cair); null quando a task já está terminal/inexistente
// e a mensagem deve ser descartada.
async function claimOrFallback(
  taskService: TaskService,
  job: JobSchema,
  log: JobLogger
): Promise<{ attempt: number } | null> {
  try {
    const claimed = await taskService.claimForExecution(job.id);
    return claimed ? { attempt: claimed.attempt } : null;
  } catch (err) {
    log.warn({ err }, "Falha ao reivindicar task — executando sem persistência");
    return { attempt: job.attempt ?? 1 };
  }
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
    await deps.taskService
      .markRetrying(args.job.id)
      .catch(warnOnFail(deps.jobLog, "markRetrying falhou durante REQUEUE"));
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
    // 1. Parse — valida o schema da mensagem antes de qualquer coisa.
    const parseResult = jobSchema.safeParse(msg.body);
    if (!parseResult.success) {
      logger.error(
        { errors: parseResult.error.flatten() },
        "Job com schema inválido — descartando"
      );

      const idParse = z.object({ id: z.string() }).safeParse(msg.body);
      if (idParse.success) {
        await taskService.markDropped(idParse.data.id, "schema_invalid").catch(() => {});
      }

      return ConsumerStatus.DROP;
    }

    const job = parseResult.data;
    const jobLog = logger.child({ jobId: job.id, type: job.type });

    // 2. Claim — reserva a task no DB para execução (idempotência e deduplicação).
    const claim = await claimOrFallback(taskService, job, jobLog);
    if (claim === null) {
      jobLog.warn("Task já terminal ou inexistente — DROP (redelivery)");
      return ConsumerStatus.DROP;
    }

    const attemptNumber = claim.attempt;
    jobLog.info({ attempt: attemptNumber }, "Job recebido — executando");

    try {
      // 3. Execute — despacha para a action correspondente ao tipo do job.
      await executeJob(job, executeDeps);

      // 4. Success — atualiza status e sinaliza para o consumer loop.
      jobLog.info("Job concluído com sucesso");
      await taskService
        .markSucceeded(job.id)
        .catch(warnOnFail(jobLog, "Falha ao marcar task succeeded — job já executado"));
      onSuccess?.();
      return undefined;
    } catch (err) {
      // 5. Failure — classifica o erro e decide entre retry, DLQ ou REQUEUE.
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
            taskService
              .markRetrying(job.id)
              .catch(
                warnOnFail(jobLog, "Falha ao marcar task retrying — status pode ficar running")
              ),
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
          taskService
            .markFailed(job.id, err)
            .catch(warnOnFail(jobLog, "Falha ao marcar task failed")),
      });
    }
  };
}
