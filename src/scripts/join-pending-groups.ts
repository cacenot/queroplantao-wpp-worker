import { randomUUID } from "node:crypto";
import { Connection } from "rabbitmq-client";
import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb } from "../db/client.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import { MessagingProviderInstanceRepository } from "../db/repositories/messaging-provider-instance-repository.ts";
import { TaskRepository } from "../db/repositories/task-repository.ts";
import { logger } from "../lib/logger.ts";
import { toWaId } from "../lib/phone.ts";
import { TaskService } from "../services/task/index.ts";

type Args = {
  instanceId: string;
  batchSize: number;
};

function parseArgs(argv: string[]): Args {
  let instanceId: string | null = null;
  let batchSize: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--instance-id":
        instanceId = argv[++i] ?? null;
        break;
      case "--batch-size": {
        const next = argv[++i];
        const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--batch-size inválido: ${next}`);
        }
        batchSize = parsed;
        break;
      }
      default:
        throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!instanceId) throw new Error("--instance-id é obrigatório");
  if (!batchSize) {
    throw new Error("--batch-size é obrigatório (ex.: --batch-size 10)");
  }
  return { instanceId, batchSize };
}

// Extrai o code do final de `https://chat.whatsapp.com/<code>` ou variantes.
// Aceita também `chat.whatsapp.com/<code>` sem schema, e ignora trailing slash.
function extractInviteCode(inviteUrl: string): string | null {
  const trimmed = inviteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const match = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  const rabbit = new Connection(env.AMQP_URL);
  const publisher = rabbit.createPublisher({ confirm: true });

  try {
    const instanceRepo = new MessagingProviderInstanceRepository(db);
    const groupsRepo = new MessagingGroupsRepository(db);
    const taskService = new TaskService({ repo: new TaskRepository(db), publisher });

    const instance = await instanceRepo.findById(args.instanceId);
    if (!instance) {
      throw new Error(`Instância ${args.instanceId} não encontrada`);
    }
    const phone = instance.zapi?.currentPhoneNumber ?? null;
    const waId = toWaId(phone);
    if (!waId) {
      throw new Error(
        `Instância ${args.instanceId} sem currentPhoneNumber válido — rode refresh do snapshot antes (current=${phone})`
      );
    }

    const candidates = await groupsRepo.listMissingForInstance({
      protocol: "whatsapp",
      instanceWaId: waId,
      limit: args.batchSize,
    });

    if (candidates.length === 0) {
      logger.info(
        { instanceWaId: waId },
        "Nenhum grupo pendente — instância já está em todos os grupos com invite_url"
      );
      return;
    }

    const jobs: Array<{
      id: string;
      type: "whatsapp.join_group_via_invite";
      createdAt: string;
      payload: { providerInstanceId: string; messagingGroupId: string; inviteCode: string };
    }> = [];
    let skippedNoCode = 0;

    for (const group of candidates) {
      if (!group.inviteUrl) {
        skippedNoCode++;
        continue;
      }
      const code = extractInviteCode(group.inviteUrl);
      if (!code) {
        skippedNoCode++;
        logger.warn(
          { groupExternalId: group.externalId, inviteUrl: group.inviteUrl },
          "invite_url não parseável — pulando"
        );
        continue;
      }
      jobs.push({
        id: randomUUID(),
        type: "whatsapp.join_group_via_invite",
        createdAt: new Date().toISOString(),
        payload: {
          providerInstanceId: args.instanceId,
          messagingGroupId: group.id,
          inviteCode: code,
        },
      });
    }

    if (jobs.length === 0) {
      logger.info({ skippedNoCode }, "Nenhum job para enfileirar — todos sem invite_url parseável");
      return;
    }

    const result = await taskService.enqueue(jobs);
    logger.info(
      {
        candidatesFound: candidates.length,
        enqueued: result.accepted,
        duplicates: result.duplicates,
        skippedNoCode,
        instanceWaId: waId,
      },
      "Jobs join_group_via_invite enfileirados"
    );
  } finally {
    await publisher.close();
    await rabbit.close();
    await sql.end();
  }
}

await main();
