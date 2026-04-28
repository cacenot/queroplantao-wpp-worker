import { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { GroupParticipantsRepository } from "../db/repositories/group-participants-repository.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import type { ProviderGatewayRegistry } from "../gateways/gateway-registry.ts";
import type { WhatsAppProvider } from "../gateways/whatsapp/types.ts";
import { logger } from "../lib/logger.ts";
import { createRedisConnection } from "../lib/redis.ts";
import { GroupParticipantsService } from "../services/group-participants/index.ts";
import { ProviderRegistryReadService } from "../services/provider-registry/provider-registry-read-service.ts";
import { TaskService } from "../services/task/index.ts";
import { buildWhatsappGatewayRegistry } from "../workers/shared/zapi-bootstrap.ts";

export type ZApiRunner = {
  registry: ProviderGatewayRegistry<WhatsAppProvider>;
  participantsService: GroupParticipantsService;
  messagingGroupsRepo: MessagingGroupsRepository;
  taskService: TaskService;
  close: () => Promise<void>;
};

/**
 * Builder compartilhado pelas CLIs Z-API (sync de participantes, join de grupos).
 *
 * Importante: o registry inclui instâncias com `is_enabled=false` (ver
 * `loadZApiProviderRows`/`listAllZApiInstances`), permitindo onboardar uma
 * instância nova antes de virar tráfego automatizado.
 */
export async function buildZApiRunner(): Promise<ZApiRunner> {
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const redis = createRedisConnection(env.REDIS_URL);
  const rabbit = new Connection(env.AMQP_URL);
  const publisher = rabbit.createPublisher({ confirm: true });

  const registryService = new ProviderRegistryReadService(db);
  const rows = await registryService.listAllZApiInstances();
  if (rows.length === 0) {
    throw new Error("Nenhuma instância Z-API encontrada no banco");
  }
  const registry = await buildWhatsappGatewayRegistry(redis, rows);
  logger.info({ count: rows.length }, "Z-API gateway registry construído (CLI)");

  const messagingGroupsRepo = new MessagingGroupsRepository(db);
  const participantsRepo = new GroupParticipantsRepository(db);
  const taskService = new TaskService({ repo: new TaskRepository(db), publisher });
  const participantsService = new GroupParticipantsService({
    repo: participantsRepo,
    messagingGroupsRepo,
  });

  return {
    registry,
    participantsService,
    messagingGroupsRepo,
    taskService,
    async close() {
      await publisher.close();
      await rabbit.close();
      redis.disconnect();
      await sql.end();
    },
  };
}
