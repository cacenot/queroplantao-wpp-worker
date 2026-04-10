import PQueue from "p-queue";

// Uma fila por targetKey — garante serialização: jobs do mesmo alvo nunca rodam em paralelo.
// O rate limiting da Z-API é responsabilidade do ZApiGateway, não deste módulo.
const queues = new Map<string, PQueue>();

/**
 * Retorna a fila de execução para um dado targetKey.
 * Se não existir, cria uma nova com concorrência 1.
 */
export function getOrCreateQueue(targetKey: string): PQueue {
  let queue = queues.get(targetKey);

  if (!queue) {
    queue = new PQueue({ concurrency: 1 });
    queues.set(targetKey, queue);
  }

  return queue;
}
