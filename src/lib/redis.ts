import Redis from "ioredis";
import { logger } from "./logger.ts";

export function createRedisConnection(url: string): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null });

  redis.on("error", (err) => {
    logger.error({ err }, "Erro na conexão Redis");
  });

  redis.on("connect", () => {
    logger.info("Conexão Redis estabelecida");
  });

  redis.on("ready", () => {
    logger.info("Redis pronto (handshake completo)");
  });

  redis.on("reconnecting", () => {
    logger.warn("Redis reconectando");
  });

  redis.on("close", () => {
    logger.warn("Conexão Redis fechada");
  });

  redis.on("end", () => {
    logger.warn("Conexão Redis encerrada (sem reconexão)");
  });

  return redis;
}
