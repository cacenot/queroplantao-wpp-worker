import { describe, expect, it } from "bun:test";
import type Redis from "ioredis";
import type { Connection } from "rabbitmq-client";
import { computeHealth } from "./health.ts";

function makeDeps(rabbitReady: boolean, redisStatus: string) {
  return {
    rabbit: { ready: rabbitReady } as unknown as Connection,
    redis: { status: redisStatus } as unknown as Redis,
  };
}

describe("computeHealth", () => {
  it("ok quando rabbit.ready=true e redis.status=ready", () => {
    const report = computeHealth(makeDeps(true, "ready"));
    expect(report.status).toBe("ok");
    expect(report.details).toEqual({ rabbit: true, redis: true });
  });

  it("degraded quando rabbit.ready=false", () => {
    const report = computeHealth(makeDeps(false, "ready"));
    expect(report.status).toBe("degraded");
    expect(report.details).toEqual({ rabbit: false, redis: true });
  });

  it("degraded quando redis.status != ready", () => {
    const report = computeHealth(makeDeps(true, "reconnecting"));
    expect(report.status).toBe("degraded");
    expect(report.details).toEqual({ rabbit: true, redis: false });
  });

  it("degraded quando ambos fora", () => {
    const report = computeHealth(makeDeps(false, "end"));
    expect(report.status).toBe("degraded");
    expect(report.details).toEqual({ rabbit: false, redis: false });
  });
});
