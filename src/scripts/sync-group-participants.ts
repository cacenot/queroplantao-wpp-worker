import { ZApiError } from "../gateways/whatsapp/zapi/client.ts";
import { normalizeGroupMetadataLight } from "../gateways/whatsapp/zapi/group-metadata-normalizer.ts";
import { logger } from "../lib/logger.ts";
import { buildZApiRunner } from "./_zapi-runner.ts";

type Args = {
  instanceId: string;
  limit: number | null;
  groupExternalId: string | null;
  markMissingAsLeft: boolean;
};

function parseArgs(argv: string[]): Args {
  let instanceId: string | null = null;
  let limit: number | null = null;
  let groupExternalId: string | null = null;
  let markMissingAsLeft = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--instance-id":
        instanceId = argv[++i] ?? null;
        break;
      case "--limit": {
        const next = argv[++i];
        const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--limit inválido: ${next}`);
        }
        limit = parsed;
        break;
      }
      case "--group-external-id":
        groupExternalId = argv[++i] ?? null;
        break;
      case "--mark-missing-as-left":
        markMissingAsLeft = true;
        break;
      default:
        throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!instanceId) {
    throw new Error("--instance-id é obrigatório");
  }
  return { instanceId, limit, groupExternalId, markMissingAsLeft };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runner = await buildZApiRunner();

  try {
    const executor = runner.registry.getByInstanceId(args.instanceId);
    if (!executor) {
      throw new Error(
        `Instância ${args.instanceId} não encontrada no registry — verifique se existe e não está arquivada.`
      );
    }

    const allGroups = await runner.messagingGroupsRepo.listByProtocol("whatsapp");
    const filtered = args.groupExternalId
      ? allGroups.filter((g) => g.externalId === args.groupExternalId)
      : allGroups;
    const target = args.limit ? filtered.slice(0, args.limit) : filtered;

    if (target.length === 0) {
      logger.info("Nenhum grupo para sincronizar");
      return;
    }

    logger.info(
      { totalGroups: target.length, instanceId: args.instanceId },
      "Iniciando sync de participantes"
    );

    let succeeded = 0;
    let failed = 0;
    let totalParticipants = 0;
    let totalUpserted = 0;
    let totalMarkedLeft = 0;

    for (let i = 0; i < target.length; i++) {
      const group = target[i];
      if (!group) continue;
      const observedAt = new Date();

      try {
        const raw = await executor.execute((provider) =>
          provider.fetchGroupMetadataLight(group.externalId)
        );
        const snapshot = normalizeGroupMetadataLight(group.externalId, raw);

        const outcome = await runner.participantsService.applySnapshot({
          providerInstanceId: args.instanceId,
          providerKind: "whatsapp_zapi",
          protocol: "whatsapp",
          groupExternalId: group.externalId,
          participants: snapshot.participants,
          observedAt,
          markMissingAsLeft: args.markMissingAsLeft,
        });

        await runner.messagingGroupsRepo.updateSyncSnapshot({
          externalId: group.externalId,
          protocol: "whatsapp",
          participantCount: snapshot.participants.length,
          syncedAt: observedAt,
        });

        succeeded++;
        totalParticipants += outcome.totalParticipants;
        totalUpserted += outcome.upserted;
        totalMarkedLeft += outcome.markedAsLeft;

        if ((i + 1) % 25 === 0 || i === target.length - 1) {
          logger.info(
            { progress: `${i + 1}/${target.length}`, succeeded, failed },
            "Progresso do sync"
          );
        }
      } catch (err) {
        failed++;
        const status = err instanceof ZApiError ? err.status : null;
        logger.warn(
          { err, groupExternalId: group.externalId, status },
          "Falha ao sincronizar grupo"
        );
      }
    }

    logger.info(
      {
        succeeded,
        failed,
        totalParticipants,
        totalUpserted,
        totalMarkedLeft,
      },
      "Sync de participantes concluído"
    );
  } finally {
    await runner.close();
  }
}

await main();
