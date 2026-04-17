import { describe, expect, it } from "bun:test";
import type { ProviderGateway } from "./gateway.ts";
import { ProviderGatewayRegistry } from "./gateway-registry.ts";
import type { MessagingProvider } from "./types.ts";

interface TestProvider extends MessagingProvider {}

function makeGateway(id: string): ProviderGateway<TestProvider> {
  return { __id: id } as unknown as ProviderGateway<TestProvider>;
}

describe("ProviderGatewayRegistry", () => {
  it("resolve gateway por providerInstanceId", () => {
    const registry = new ProviderGatewayRegistry<TestProvider>();
    const gatewayA = makeGateway("a");
    const gatewayB = makeGateway("b");

    registry.register("inst-a", gatewayA);
    registry.register("inst-b", gatewayB);

    expect(registry.getByInstanceId("inst-a")).toBe(gatewayA);
    expect(registry.getByInstanceId("inst-b")).toBe(gatewayB);
  });

  it("retorna undefined para id desconhecido", () => {
    const registry = new ProviderGatewayRegistry<TestProvider>();
    expect(registry.getByInstanceId("nope")).toBeUndefined();
  });

  it("múltiplos providerInstanceIds podem compartilhar o mesmo gateway (mesmo pool)", () => {
    const registry = new ProviderGatewayRegistry<TestProvider>();
    const gateway = makeGateway("shared");

    registry.register("inst-a", gateway);
    registry.register("inst-b", gateway);

    expect(registry.getByInstanceId("inst-a")).toBe(gateway);
    expect(registry.getByInstanceId("inst-b")).toBe(gateway);
  });

  it("lança erro ao registrar providerInstanceId duplicado", () => {
    const registry = new ProviderGatewayRegistry<TestProvider>();
    const gateway = makeGateway("x");

    registry.register("inst-a", gateway);
    expect(() => registry.register("inst-a", gateway)).toThrow(/duplicado/);
  });
});
