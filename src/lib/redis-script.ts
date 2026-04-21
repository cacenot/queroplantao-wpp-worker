import type Redis from "ioredis";

export function defineRedisScript(
  redis: Redis,
  name: string,
  lua: string,
  numberOfKeys: number
): void {
  redis.defineCommand(name, { numberOfKeys, lua });
}
