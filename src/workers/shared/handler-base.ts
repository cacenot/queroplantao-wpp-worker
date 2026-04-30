import * as Sentry from "@sentry/bun";
import type { Logger } from "pino";
import type { AsyncMessage, Publisher } from "rabbitmq-client";
import { ConsumerStatus } from "rabbitmq-client";
import { z } from "zod";
import { dlqForJob, priorityForJob, retryQueueForJob } from "../../jobs/routing.ts";
import { type JobSchema, jobSchema } from "../../jobs/schemas.ts";
import { NonRetryableError } from "../../lib/errors.ts";
import { warnOnFail } from "../../lib/log-helpers.ts";
import { logger } from "../../lib/logger.ts";
import type { TaskService } from "../../services/task/index.ts";

type JobLogger = Logger;

export type ExecuteJobFn = (job: JobSchema) => Promise<void>;

export type JobHandlerOptions = {
  /**
   * Executa o job. Deve fazer um switch restrito aos tipos que este worker processa
   * e lançar `NonRetryableError` caso receba um tipo fora do seu escopo (guarda contra
   * routing quebrado — mensagem vai direto pra DLQ do tipo correto).
   */
  executeJob: ExecuteJobFn;
  taskService: TaskService;
  publisher: Publisher;
  maxRetries: number;
  /**
   * Callback opcional disparado quando o job vai para a DLQ (NonRetryable ou
   * `attempt > maxRetries`). Usado por workers que mantêm tabelas espelho do
   * lifecycle (ex.: `outbound_messages`) para sincronizar estado terminal.
   * Best-effort: erros são logados como warn e não abortam o fluxo de DLQ.
   */
  onTerminalFailure?: (job: JobSchema, err: unknown) => Promise<void>;
};

type PublishDeps = {
  publisher: Publisher;
  taskService: TaskService;
  jobLog: JobLogger;
};

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

// `durable: true` é o alias do rabbitmq-client para deliveryMode=2
// (mensagem persistente — sobrevive a restart do broker).
async function publishOrRequeue(
  deps: PublishDeps,
  args: {
    queue: string;
    priority: number | undefined;
    job: JobSchema;
    attempt: number;
    onPublished: () => Promise<unknown>;
  }
): Promise<ConsumerStatus> {
  try {
    await deps.publisher.send(
      { routingKey: args.queue, durable: true, priority: args.priority },
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
  const { executeJob, taskService, publisher, maxRetries, onTerminalFailure } = options;

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
        await taskService
          .markDropped(idParse.data.id, "schema_invalid")
          .catch(warnOnFail(logger, "markDropped falhou (schema inválido)"));
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
      // 3. Execute — delega para o executeJob do worker (switch restrito por tipo).
      await executeJob(job);

      // 4. Success — atualiza status e sinaliza para o consumer loop.
      jobLog.info("Job concluído com sucesso");
      await taskService
        .markSucceeded(job.id)
        .catch(warnOnFail(jobLog, "Falha ao marcar task succeeded — job já executado"));
      return undefined;
    } catch (err) {
      // 5. Failure — classifica o erro e decide entre retry, DLQ ou REQUEUE.
      const isNonRetryable = err instanceof NonRetryableError;
      const retriesUsed = attemptNumber - 1;
      const canRetry = !isNonRetryable && retriesUsed < maxRetries;
      const publishDeps: PublishDeps = { publisher, taskService, jobLog };
      const priority = priorityForJob(job.type);

      Sentry.captureException(err, {
        tags: { jobType: job.type, terminal: String(!canRetry) },
        extra: { jobId: job.id, attempt: attemptNumber, payload: job.payload },
      });

      if (canRetry) {
        const retryQueue = retryQueueForJob(job.type);
        jobLog.warn(
          { err, attempt: attemptNumber, retryQueue },
          "Erro ao executar job — agendando retry"
        );
        return publishOrRequeue(publishDeps, {
          queue: retryQueue,
          priority,
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
      const dlqName = dlqForJob(job.type);
      jobLog.error({ err, attempt: attemptNumber, reason, dlqName }, "Enviando job para DLQ");

      if (onTerminalFailure) {
        await onTerminalFailure(job, err).catch(
          warnOnFail(jobLog, "onTerminalFailure falhou — segue para DLQ")
        );
      }

      return publishOrRequeue(publishDeps, {
        queue: dlqName,
        priority,
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
