import { GroupMessagesRepository } from "../../db/repositories/group-messages-repository.ts";
import type { GatewayRegistry } from "../../gateways/gateway-registry.ts";
import type { WhatsAppProvider } from "../../gateways/whatsapp/types.ts";
import { buildSharedDeps, type SharedDeps } from "../shared/build-shared-deps.ts";
import { buildWhatsappGatewayRegistry, loadZApiProviderRows } from "../shared/zapi-bootstrap.ts";

export type ZapiWorkerDeps = SharedDeps & {
  whatsappGatewayRegistry: GatewayRegistry<WhatsAppProvider>;
  groupMessagesRepo: GroupMessagesRepository;
};

export async function buildZapiWorkerDeps(): Promise<ZapiWorkerDeps> {
  const shared = await buildSharedDeps();

  const zapiRows = await loadZApiProviderRows(shared.db);
  const whatsappGatewayRegistry = await buildWhatsappGatewayRegistry(shared.redis, zapiRows);
  const groupMessagesRepo = new GroupMessagesRepository(shared.db);

  return {
    ...shared,
    whatsappGatewayRegistry,
    groupMessagesRepo,
  };
}
