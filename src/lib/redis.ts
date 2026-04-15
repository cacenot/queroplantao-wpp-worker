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

  return redis;
}
