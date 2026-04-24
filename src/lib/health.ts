import type Redis from "ioredis";
import type { Connection } from "rabbitmq-client";

export type HealthDeps = {
  rabbit: Connection;
  redis: Redis;
};

export type HealthReport = {
  status: "ok" | "degraded";
  details: {
    rabbit: boolean;
    redis: boolean;
  };
};

// Pull-based: lê estado atual das libs (ambas reconectam sozinhas) em vez de flag reativa.
export function computeHealth(deps: HealthDeps): HealthReport {
  const rabbit = deps.rabbit.ready;
  const redis = deps.redis.status === "ready";
  return {
    status: rabbit && redis ? "ok" : "degraded",
    details: { rabbit, redis },
  };
}
