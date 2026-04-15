import { ZApiClient } from "./client.ts";
import type { ZApiInstanceConfig } from "./types.ts";

export function createZApiProviders(configs: ZApiInstanceConfig[]): ZApiClient[] {
  return configs.map((config) => new ZApiClient(config));
}
