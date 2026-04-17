import type { ProviderGateway } from "./gateway.ts";
import type { MessagingProvider, ProviderExecutor } from "./types.ts";

export interface GatewayRegistry<T extends MessagingProvider> {
  getByInstanceId(providerInstanceId: string): ProviderExecutor<T> | undefined;
}

export class ProviderGatewayRegistry<T extends MessagingProvider> implements GatewayRegistry<T> {
  private readonly byInstanceId = new Map<string, ProviderGateway<T>>();

  register(providerInstanceId: string, gateway: ProviderGateway<T>): void {
    if (this.byInstanceId.has(providerInstanceId)) {
      throw new Error(`providerInstanceId duplicado no registry: ${providerInstanceId}`);
    }
    this.byInstanceId.set(providerInstanceId, gateway);
  }

  getByInstanceId(providerInstanceId: string): ProviderGateway<T> | undefined {
    return this.byInstanceId.get(providerInstanceId);
  }
}
