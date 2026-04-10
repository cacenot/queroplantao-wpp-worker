import type amqplib from "amqplib";
import { deleteMessage } from "../actions/delete-message.ts";
import { removeParticipant } from "../actions/remove-participant.ts";
import { logger } from "../lib/logger.ts";
import { getOrCreateQueue } from "../queues/target-queue.ts";
import type { ZApiGateway } from "../zapi/gateway.ts";
import { jobSchema } from "./schemas.ts";

/**
 * Cria o handler principal de mensagens AMQP.
 *
 * O gateway é injetado como dependência — encapsula seleção de instância,
 * rate limiting e delay entre requisições.
 */
export function createJobHandler(channel: amqplib.Channel, gateway: ZApiGateway) {
  return async function handleMessage(msg: amqplib.ConsumeMessage | null): Promise<void> {
    if (!msg) return;

    // 1. Parse do JSON da mensagem
    let rawJob: unknown;
    try {
      rawJob = JSON.parse(msg.content.toString());
    } catch {
      logger.error(
        { deliveryTag: msg.fields.deliveryTag },
        "Mensagem com JSON inválido — descartando"
      );
      channel.nack(msg, false, false);
      return;
    }

    // 2. Validação com zod
    const parseResult = jobSchema.safeParse(rawJob);
    if (!parseResult.success) {
      logger.error(
        { errors: parseResult.error.flatten(), deliveryTag: msg.fields.deliveryTag },
        "Job com schema inválido — descartando"
      );
      // TODO: publicar na DLQ antes do nack quando implementado
      channel.nack(msg, false, false);
      return;
    }

    const job = parseResult.data;
    const jobLog = logger.child({ jobId: job.id, type: job.type, targetKey: job.targetKey });

    jobLog.info("Job recebido — enfileirando para execução");

    // 3. Obtém (ou cria) a fila serializada para este targetKey
    const queue = getOrCreateQueue(job.targetKey);

    // 4. Enfileira a execução — o ACK só ocorre dentro da tarefa, após sucesso
    queue.add(async () => {
      try {
        // 5. Roteamento por tipo de job — cada action usa o gateway internamente
        switch (job.type) {
          case "delete_message":
            await deleteMessage(job.payload, gateway);
            break;
          case "remove_participant":
            await removeParticipant(job.payload, gateway);
            break;
        }

        // 6. ACK apenas após sucesso confirmado
        channel.ack(msg);
        jobLog.info("Job concluído com sucesso");
      } catch (err) {
        jobLog.error({ err, attempt: job.attempt }, "Erro ao executar job");

        // TODO: incrementar attempt e publicar na DLQ para retry controlado
        channel.nack(msg, false, false);
      }
    });
  };
}
