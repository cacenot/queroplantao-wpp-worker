import { env } from "../config/env.ts";
import { createDbConnection, createDrizzleDb, type Db } from "../db/client.ts";
import { GroupParticipantsRepository } from "../db/repositories/group-participants-repository.ts";
import { MessagingGroupsRepository } from "../db/repositories/messaging-groups-repository.ts";
import type { MessagingGroup } from "../db/schema/messaging-groups.ts";
import { ZApiClient, ZApiError } from "../gateways/whatsapp/zapi/client.ts";
import { normalizeGroupMetadataLight } from "../gateways/whatsapp/zapi/group-metadata-normalizer.ts";
import type { ZApiGroupMetadataLight } from "../gateways/whatsapp/zapi/group-metadata-schema.ts";
import { GroupParticipantsService } from "../services/group-participants/index.ts";
import { ProviderRegistryReadService } from "../services/provider-registry/provider-registry-read-service.ts";

// =============================================================================
// Args
// =============================================================================

export type Args = {
  instanceId: string;
  limit: number | null;
  groupExternalId: string | null;
  markMissingAsLeft: boolean;
  staleHours: number;
  concurrency: number;
};

export function parseArgs(argv: string[]): Args {
  let instanceId: string | null = null;
  let limit: number | null = null;
  let groupExternalId: string | null = null;
  let markMissingAsLeft = false;
  let staleHours = 24;
  let concurrency = 5;

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
      case "--stale-hours": {
        const next = argv[++i];
        const parsed = next ? Number.parseFloat(next) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`--stale-hours inválido: ${next}`);
        }
        staleHours = parsed;
        break;
      }
      case "--concurrency": {
        const next = argv[++i];
        const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`--concurrency inválido: ${next}`);
        }
        concurrency = parsed;
        break;
      }
      default:
        throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!instanceId) {
    throw new Error("--instance-id é obrigatório");
  }
  return { instanceId, limit, groupExternalId, markMissingAsLeft, staleHours, concurrency };
}

// =============================================================================
// Retry
// =============================================================================

export const MAX_ATTEMPTS = 5;
export const BASE_DELAY_MS = 1_000;

export function isRetryable(err: unknown): boolean {
  if (err instanceof ZApiError) {
    return err.status === 0 || err.status === 429 || err.status >= 500;
  }
  return true;
}

export type RetryNotice = {
  label: string;
  attempt: number;
  nextDelayMs: number;
  err: unknown;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: {
    sleepMs?: (ms: number) => Promise<void>;
    onRetry?: (notice: RetryNotice) => void;
  } = {}
): Promise<T> {
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
      const nextDelayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
      opts.onRetry?.({ label, attempt, nextDelayMs, err });
      await sleep(nextDelayMs);
    }
  }
  throw lastErr;
}

// =============================================================================
// UI
// =============================================================================

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${String(sec).padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${String(remMin).padStart(2, "0")}m`;
}

export function renderBar(done: number, total: number, width = 30): string {
  if (total <= 0) return `[${"░".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export type HeaderInfo = {
  instanceId: string;
  totalEligible: number;
  staleHours: number;
  cutoff: Date | null;
  concurrency: number;
  markMissingAsLeft: boolean;
  groupExternalIdFilter: string | null;
};

export type ProgressInfo = {
  done: number;
  total: number;
  succeeded: number;
  failed: number;
  retries: number;
  elapsedMs: number;
};

export type SummaryInfo = {
  succeeded: number;
  failed: number;
  totalEligible: number;
  totalParticipants: number;
  totalUpserted: number;
  totalMarkedLeft: number;
  durationMs: number;
  aborted: boolean;
};

export type SyncUI = {
  printHeader(info: HeaderInfo): void;
  updateProgress(info: ProgressInfo): void;
  printRetryNotice(notice: RetryNotice): void;
  printFailure(info: { groupExternalId: string; err: unknown }): void;
  printAbort(message: string): void;
  printSummary(info: SummaryInfo): void;
};

export const silentUI: SyncUI = {
  printHeader: () => {},
  updateProgress: () => {},
  printRetryNotice: () => {},
  printFailure: () => {},
  printAbort: () => {},
  printSummary: () => {},
};

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function describeError(err: unknown): string {
  if (err instanceof ZApiError) {
    return err.status === 0 ? `timeout (${err.message})` : `Z-API ${err.status} (${err.message})`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createSyncUI(stdout: NodeJS.WriteStream = process.stdout): SyncUI {
  const isTTY = stdout.isTTY === true;
  const paint = (color: string, s: string) => (isTTY ? `${color}${s}${ANSI.reset}` : s);
  const bold = (s: string) => paint(ANSI.bold, s);
  const dim = (s: string) => paint(ANSI.dim, s);
  const green = (s: string) => paint(ANSI.green, s);
  const red = (s: string) => paint(ANSI.red, s);
  const yellow = (s: string) => paint(ANSI.yellow, s);
  const cyan = (s: string) => paint(ANSI.cyan, s);

  const RULE = "─".repeat(60);
  let lastProgressLine = "";

  function clearLine() {
    if (isTTY && lastProgressLine.length > 0) {
      stdout.write(`\r\x1b[2K`);
      lastProgressLine = "";
    }
  }

  function reprintLastProgress() {
    if (isTTY && lastProgressLine.length > 0) {
      stdout.write(`\r${lastProgressLine}`);
    }
  }

  function writeLine(s: string) {
    clearLine();
    stdout.write(`${s}\n`);
    reprintLastProgress();
  }

  function fmtCutoff(date: Date | null) {
    if (!date) return "—";
    const iso = date
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, " UTC");
    return iso;
  }

  return {
    printHeader(info) {
      stdout.write(`\n${dim(RULE)}\n`);
      stdout.write(`  ${bold("Sync de participantes Z-API")}\n`);
      stdout.write(`${dim(RULE)}\n`);
      stdout.write(`  ${dim("Instância:        ")}${cyan(info.instanceId)}\n`);
      if (info.groupExternalIdFilter) {
        stdout.write(`  ${dim("Grupo (manual):   ")}${cyan(info.groupExternalIdFilter)}\n`);
        stdout.write(`  ${dim("Cutoff:           ")}${dim("ignorado (filtro pontual)")}\n`);
      } else {
        stdout.write(`  ${dim("Grupos elegíveis: ")}${bold(String(info.totalEligible))}\n`);
        stdout.write(
          `  ${dim("Cutoff:           ")}synced_at < ${fmtCutoff(info.cutoff)} ${dim(`(${info.staleHours}h)`)}\n`
        );
      }
      stdout.write(`  ${dim("Concorrência:     ")}${bold(String(info.concurrency))}\n`);
      stdout.write(
        `  ${dim("Mark missing:     ")}${info.markMissingAsLeft ? yellow("on") : dim("off")}\n`
      );
      stdout.write(`${dim(RULE)}\n\n`);
    },
    updateProgress(info) {
      const pctText =
        info.total === 0
          ? "  0%"
          : `${String(Math.round((info.done / info.total) * 100)).padStart(3)}%`;
      const bar = renderBar(info.done, info.total);
      const counts =
        `${green(`✓${info.succeeded}`)} ` +
        `${info.failed > 0 ? red(`✗${info.failed}`) : dim(`✗${info.failed}`)} ` +
        `${info.retries > 0 ? yellow(`↻${info.retries}`) : dim(`↻${info.retries}`)}`;
      const elapsed = fmtDuration(info.elapsedMs);
      const eta =
        info.done > 0 && info.done < info.total
          ? ` ${dim("·")} ETA ~${fmtDuration((info.elapsedMs / info.done) * (info.total - info.done))}`
          : "";
      const line =
        `  ${cyan(bar)} ${bold(pctText)}  ` +
        `${dim(`${info.done}/${info.total}`)}  ${counts}  ` +
        `${dim(`${elapsed}${eta}`)}`;
      if (isTTY) {
        stdout.write(`\r\x1b[2K${line}`);
        lastProgressLine = line;
      } else {
        stdout.write(`${line}\n`);
      }
    },
    printRetryNotice(notice) {
      const msg = `  ${yellow("↻")} ${dim(notice.label)} — ${describeError(notice.err)} ${dim(`(tentativa ${notice.attempt}/${MAX_ATTEMPTS}, próxima em ${fmtDuration(notice.nextDelayMs)})`)}`;
      writeLine(msg);
    },
    printFailure(info) {
      const msg = `  ${red("✗")} ${cyan(info.groupExternalId)} — ${describeError(info.err)} ${dim(`(após ${MAX_ATTEMPTS} tentativas)`)}`;
      writeLine(msg);
    },
    printAbort(message) {
      writeLine(`  ${red("✗ ABORT:")} ${message}`);
    },
    printSummary(info) {
      clearLine();
      const total = info.totalEligible;
      const throughput =
        info.durationMs > 0 ? ((info.succeeded / info.durationMs) * 1000).toFixed(2) : "0.00";
      stdout.write(`\n${dim(RULE)}\n`);
      stdout.write(`  ${bold(info.aborted ? red("Resultado (ABORTADO)") : "Resultado")}\n`);
      stdout.write(`${dim(RULE)}\n`);
      stdout.write(
        `  ${dim("Sincronizados:    ")}${green(String(info.succeeded))}${dim(` / ${total}`)}\n`
      );
      stdout.write(
        `  ${dim("Falhas:           ")}${info.failed > 0 ? red(String(info.failed)) : dim("0")}\n`
      );
      stdout.write(
        `  ${dim("Participantes:    ")}${bold(String(info.totalParticipants))} ${dim(`(upserts: ${info.totalUpserted}, marcados como left: ${info.totalMarkedLeft})`)}\n`
      );
      stdout.write(`  ${dim("Tempo total:      ")}${bold(fmtDuration(info.durationMs))}\n`);
      stdout.write(`  ${dim("Throughput:       ")}${bold(`${throughput} grupos/s`)}\n`);
      stdout.write(`${dim(RULE)}\n`);
    },
  };
}

// =============================================================================
// Z-API client
// =============================================================================

async function buildZApiClientForInstance(db: Db, instanceId: string): Promise<ZApiClient> {
  const registry = new ProviderRegistryReadService(db);
  const rows = await registry.listAllZApiInstances();
  const row = rows.find((r) => r.providerId === instanceId);
  if (!row) {
    throw new Error(
      `Instância ${instanceId} não encontrada — verifique se existe e não está arquivada.`
    );
  }
  return new ZApiClient({
    providerInstanceId: row.providerId,
    instance_id: row.instanceId,
    instance_token: row.instanceToken,
    client_token: row.customClientToken ?? env.ZAPI_CLIENT_TOKEN,
  });
}

// =============================================================================
// Core
// =============================================================================

export type SyncClient = {
  fetchGroupMetadataLight(groupId: string): Promise<ZApiGroupMetadataLight>;
};

export type RunSummary = {
  totalEligible: number;
  succeeded: number;
  failed: number;
  totalParticipants: number;
  totalUpserted: number;
  totalMarkedLeft: number;
  durationMs: number;
  aborted: boolean;
};

export type RunDeps = {
  db: Db;
  client: SyncClient;
  args: Args;
  ui?: SyncUI;
  sleepMs?: (ms: number) => Promise<void>;
};

export async function runSyncGroupParticipants(deps: RunDeps): Promise<RunSummary> {
  const { db, client, args } = deps;
  const ui = deps.ui ?? createSyncUI();
  const messagingGroupsRepo = new MessagingGroupsRepository(db);

  // — Etapa: seleção dos grupos
  const cutoff = new Date(Date.now() - args.staleHours * 3600_000);
  const target = await selectTargetGroups({ messagingGroupsRepo, args, cutoff });

  ui.printHeader({
    instanceId: args.instanceId,
    totalEligible: target.length,
    staleHours: args.staleHours,
    cutoff: args.groupExternalId ? null : cutoff,
    concurrency: args.concurrency,
    markMissingAsLeft: args.markMissingAsLeft,
    groupExternalIdFilter: args.groupExternalId,
  });

  const startedAt = Date.now();

  if (target.length === 0) {
    const summary: RunSummary = {
      totalEligible: 0,
      succeeded: 0,
      failed: 0,
      totalParticipants: 0,
      totalUpserted: 0,
      totalMarkedLeft: 0,
      durationMs: Date.now() - startedAt,
      aborted: false,
    };
    ui.printSummary({ ...summary });
    return summary;
  }

  let succeeded = 0;
  let failed = 0;
  let retries = 0;
  let totalParticipants = 0;
  let totalUpserted = 0;
  let totalMarkedLeft = 0;

  // — Etapa: processamento em batches paralelos
  for (let i = 0; i < target.length; i += args.concurrency) {
    const batch = target.slice(i, i + args.concurrency);
    const results = await Promise.allSettled(
      batch.map((group) =>
        syncOneGroup({
          group,
          db,
          client,
          args,
          onRetry: (notice) => {
            retries++;
            ui.printRetryNotice(notice);
          },
          sleepMs: deps.sleepMs,
        })
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const group = batch[j];
      if (!result || !group) continue;
      if (result.status === "fulfilled") {
        succeeded++;
        totalParticipants += result.value.totalParticipants;
        totalUpserted += result.value.upserted;
        totalMarkedLeft += result.value.markedAsLeft;
      } else {
        failed++;
        ui.printFailure({ groupExternalId: group.externalId, err: result.reason });
      }
    }

    ui.updateProgress({
      done: Math.min(i + batch.length, target.length),
      total: target.length,
      succeeded,
      failed,
      retries,
      elapsedMs: Date.now() - startedAt,
    });

    // Abort no primeiro grupo que esgote retries — provável problema estrutural.
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      const summary: RunSummary = {
        totalEligible: target.length,
        succeeded,
        failed,
        totalParticipants,
        totalUpserted,
        totalMarkedLeft,
        durationMs: Date.now() - startedAt,
        aborted: true,
      };
      ui.printAbort(
        "ao menos um grupo falhou após esgotar tentativas (provável problema estrutural: API down, credenciais inválidas, etc.)"
      );
      ui.printSummary(summary);
      throw rejected.reason;
    }
  }

  const summary: RunSummary = {
    totalEligible: target.length,
    succeeded,
    failed,
    totalParticipants,
    totalUpserted,
    totalMarkedLeft,
    durationMs: Date.now() - startedAt,
    aborted: false,
  };
  ui.printSummary(summary);
  return summary;
}

async function selectTargetGroups(deps: {
  messagingGroupsRepo: MessagingGroupsRepository;
  args: Args;
  cutoff: Date;
}): Promise<MessagingGroup[]> {
  const { messagingGroupsRepo, args, cutoff } = deps;

  if (args.groupExternalId) {
    const group = await messagingGroupsRepo.findByExternalId(args.groupExternalId, "whatsapp");
    return group ? [group] : [];
  }

  return messagingGroupsRepo.listStaleByProtocol({
    protocol: "whatsapp",
    syncedBefore: cutoff,
    limit: args.limit ?? undefined,
  });
}

async function syncOneGroup(deps: {
  group: MessagingGroup;
  db: Db;
  client: SyncClient;
  args: Args;
  onRetry: (notice: RetryNotice) => void;
  sleepMs?: (ms: number) => Promise<void>;
}) {
  const { group, db, client, args, onRetry, sleepMs } = deps;
  const observedAt = new Date();

  // Fetch FORA da transação — não consome conexão DB durante I/O Z-API.
  const raw = await withRetry(
    () => client.fetchGroupMetadataLight(group.externalId),
    `fetchGroupMetadataLight(${group.externalId})`,
    { onRetry, sleepMs }
  );
  const snapshot = normalizeGroupMetadataLight(group.externalId, raw);

  // Persistência DENTRO da transação — atômica por grupo.
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const txParticipantsRepo = new GroupParticipantsRepository(txDb);
    const txGroupsRepo = new MessagingGroupsRepository(txDb);
    const txService = new GroupParticipantsService({
      repo: txParticipantsRepo,
      messagingGroupsRepo: txGroupsRepo,
    });

    const outcome = await txService.applySnapshot({
      providerInstanceId: args.instanceId,
      providerKind: "whatsapp_zapi",
      protocol: "whatsapp",
      groupExternalId: group.externalId,
      participants: snapshot.participants,
      observedAt,
      markMissingAsLeft: args.markMissingAsLeft,
    });

    await txGroupsRepo.updateSyncSnapshot({
      externalId: group.externalId,
      protocol: "whatsapp",
      participantCount: snapshot.participants.length,
      syncedAt: observedAt,
    });

    return outcome;
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = createDbConnection();
  const db = createDrizzleDb(sql);
  let aborted = false;
  try {
    const client = await buildZApiClientForInstance(db, args.instanceId);
    const summary = await runSyncGroupParticipants({ db, client, args });
    if (summary.failed > 0) process.exitCode = 1;
  } catch (_err) {
    aborted = true;
    process.exitCode = 1;
  } finally {
    await sql.end();
    if (aborted) process.exit(process.exitCode ?? 1);
  }
}

if (import.meta.main) {
  await main();
}
