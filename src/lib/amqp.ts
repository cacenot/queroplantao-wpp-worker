import amqplib from "amqplib";
import { env } from "../config/env.ts";
import { logger } from "./logger.ts";

export interface AmqpContext {
  // amqplib.connect() retorna ChannelModel (que possui close(), createChannel(), etc.)
  connection: amqplib.ChannelModel;
  channel: amqplib.Channel;
}

/**
 * Cria uma conexão AMQP e um channel configurado com prefetch.
 * O channel opera em modo de confirmação manual (noAck: false),
 * garantindo que o ACK só ocorra após processamento bem-sucedido.
 */
export async function connectAmqp(): Promise<AmqpContext> {
  const connection = await amqplib.connect(env.AMQP_URL);
  const channel = await connection.createChannel();

  // Limita mensagens em voo por processo — chave para controle de pressão
  await channel.prefetch(env.AMQP_PREFETCH);

  // Garante que a fila existe antes de consumir
  await channel.assertQueue(env.AMQP_QUEUE, { durable: true });

  logger.info({ queue: env.AMQP_QUEUE, prefetch: env.AMQP_PREFETCH }, "AMQP conectado");

  return { connection, channel };
}
