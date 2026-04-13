import { ConsumerStatus } from "rabbitmq-client";
import type { AsyncMessage } from "rabbitmq-client";
import type { MessageAnalysis } from "../ai/moderator.ts";
import { analyzeMessage } from "../actions/analyze-message.ts";
import { deleteMessage } from "../actions/delete-message.ts";
import { removeParticipant } from "../actions/remove-participant.ts";
import type { Sql } from "../lib/db.ts";
import { logger } from "../lib/logger.ts";
import type { QpAdminApiClient } from "../lib/qp-admin-api.ts";
import { getOrCreateQueue } from "../queues/target-queue.ts";
import type { ZApiGateway } from "../zapi/gateway.ts";
import { jobSchema } from "./schemas.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;

/**
 * Cria o handler principal de mensagens AMQP.
 *
 * O gateway é injetado como dependência — encapsula seleção de instância,
 * rate limiting e delay entre requisições.
 *
 * Retorna ConsumerStatus para controlar ack/nack:
 * - void (implícito) → ACK
 * - ConsumerStatus.DROP → nack sem requeue (mensagem descartada ou enviada à DLX)
 */
export function createJobHandler(
  gateway: ZApiGateway,
  sql: Sql,
  classifyMessage: ClassifyFn,
  adminApi: QpAdminApiClient
) {
  return async function handleMessage(msg: AsyncMessage): Promise<ConsumerStatus | undefined> {
    // 1. Validação com zod (msg.body já é o JSON parseado pelo rabbitmq-client)
    const parseResult = jobSchema.safeParse(msg.body);
    if (!parseResult.success) {
      logger.error(
        { errors: parseResult.error.flatten() },
        "Job com schema inválido — descartando"
      );
      return ConsumerStatus.DROP;
    }

    const job = parseResult.data;
    const jobLog = logger.child({ jobId: job.id, type: job.type, targetKey: job.targetKey });

    jobLog.info("Job recebido — enfileirando para execução");

    // 2. Obtém (ou cria) a fila serializada para este targetKey
    const queue = getOrCreateQueue(job.targetKey);

    // 3. Enfileira a execução — aguarda conclusão para que o Consumer faça ack/nack
    const result = await queue.add(async () => {
      try {
        // 4. Roteamento por tipo de job — cada action usa o gateway internamente
        switch (job.type) {
          case "delete_message":
            await deleteMessage(job.payload, gateway, sql);
            break;
          case "remove_participant":
            await removeParticipant(job.payload, gateway);
            break;
          case "analyze_message":
            await analyzeMessage(job.payload, classifyMessage, adminApi);
            break;
        }

        jobLog.info("Job concluído com sucesso");
        // retorno implícito undefined → ACK
      } catch (err) {
        jobLog.error({ err, attempt: job.attempt }, "Erro ao executar job");
        // TODO: incrementar attempt e publicar na DLQ para retry controlado
        return ConsumerStatus.DROP;
      }
    });

    return result ?? undefined;
  };
}
