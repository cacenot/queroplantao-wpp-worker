import { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { logger } from "./logger.ts";

/**
 * Cria uma conexão AMQP com reconexão automática.
 * Consumer e Publisher devem ser criados a partir desta conexão.
 */
export function createAmqpConnection(): Connection {
  const rabbit = new Connection(env.AMQP_URL);

  rabbit.on("error", (err) => {
    logger.error({ err }, "Erro na conexão AMQP");
  });

  rabbit.on("connection", () => {
    logger.info("Conexão AMQP estabelecida");
  });

  return rabbit;
}
