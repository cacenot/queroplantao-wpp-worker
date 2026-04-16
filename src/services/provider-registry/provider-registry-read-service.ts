import type { Db } from "../../db/client.ts";
import { MessagingProviderInstanceRepository } from "../../db/repositories/messaging-provider-instance-repository.ts";
import { parseZApiProviderRegistryRows, type ZApiProviderRegistryRow } from "./zod.ts";

export class ProviderRegistryReadService {
  private readonly repo: MessagingProviderInstanceRepository;

  constructor(db: Db) {
    this.repo = new MessagingProviderInstanceRepository(db);
  }

  async listEnabledZApiInstances(): Promise<ZApiProviderRegistryRow[]> {
    const rows = await this.repo.listEnabledZApiRows();
    return parseZApiProviderRegistryRows(rows);
  }
}
