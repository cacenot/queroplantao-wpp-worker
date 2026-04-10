import PQueue from "p-queue";
import { logger } from "../lib/logger.ts";
import { ZApiClient } from "../lib/zapi-client.ts";
import type { ZApiInstance } from "./types.ts";

interface ZApiGatewayOptions {
  instances: ZApiInstance[];
  concurrencyPerInstance: number;
  delayMinMs: number;
  delayMaxMs: number;
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gateway de acesso controlado à Z-API.
 *
 * Encapsula três responsabilidades intimamente relacionadas:
 * 1. Seleção de instância (round-robin)
 * 2. Rate limiting global (PQueue com concurrency = N × instances.length)
 * 3. Jitter entre requisições (delay aleatório após cada execução)
 *
 * O caller recebe um ZApiClient pré-configurado e não precisa saber
 * qual instância foi escolhida nem como o rate limit funciona.
 *
 * LIMITAÇÃO: O round-robin vive in-process. Em cenários com múltiplos
 * workers, cada processo terá seu próprio contador. Para coordenação
 * distribuída, evoluir para Redis INCR atômico ou similar.
 */
export class ZApiGateway {
  private readonly queue: PQueue;
  private readonly instances: ZApiInstance[];
  private readonly delayMinMs: number;
  private readonly delayMaxMs: number;
  private counter = 0;

  constructor(options: ZApiGatewayOptions) {
    const { instances, concurrencyPerInstance, delayMinMs, delayMaxMs } = options;

    if (instances.length === 0) {
      throw new Error("Nenhuma instância Z-API configurada");
    }

    this.instances = instances;
    this.delayMinMs = delayMinMs;
    this.delayMaxMs = delayMaxMs;

    const totalConcurrency = concurrencyPerInstance * instances.length;

    this.queue = new PQueue({ concurrency: totalConcurrency });

    logger.info(
      {
        instances: instances.length,
        concurrencyPerInstance,
        totalConcurrency,
        delayMinMs,
        delayMaxMs,
      },
      "ZApiGateway inicializado"
    );
  }

  /**
   * Executa uma operação na Z-API com rate limit e seleção de instância.
   *
   * O callback recebe um ZApiClient já configurado com a instância escolhida.
   * O slot do PQueue fica ocupado durante a execução + delay aleatório,
   * criando jitter natural entre requisições consecutivas.
   */
  async execute<T>(fn: (client: ZApiClient) => Promise<T>): Promise<T> {
    return this.queue.add(async () => {
      const instance = this.selectInstance();
      const client = new ZApiClient(instance);

      const result = await fn(client);

      // Delay aleatório APÓS a execução — mantém o slot ocupado,
      // espaçando requisições com jitter imprevisível
      const delay = randomDelay(this.delayMinMs, this.delayMaxMs);
      await sleep(delay);

      return result;
    }) as Promise<T>;
  }

  private selectInstance(): ZApiInstance {
    const instance = this.instances[this.counter % this.instances.length];
    this.counter++;

    if (this.counter >= Number.MAX_SAFE_INTEGER) {
      this.counter = 0;
    }

    // instances.length >= 1, mas noUncheckedIndexedAccess exige a checagem
    if (!instance) {
      throw new Error("Falha ao selecionar instância Z-API");
    }

    return instance;
  }
}

/**
 * Contrato mínimo exigido pelas actions.
 * Usar este tipo em vez de ZApiGateway facilita testes (mocks tipados)
 * e respeita o Princípio da Segregação de Interfaces (ISP).
 */
export type ZApiExecutor = Pick<ZApiGateway, "execute">;
