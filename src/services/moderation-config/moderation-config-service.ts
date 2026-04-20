import { createHash } from "node:crypto";
import type { ModerationConfigRepository } from "../../db/repositories/moderation-config-repository.ts";
import type {
  ModerationConfigRow,
  NewModerationConfigRow,
} from "../../db/schema/moderation-configs.ts";
import { logger } from "../../lib/logger.ts";
import type { ModerationConfigCache } from "./moderation-config-cache.ts";
import { toModerationConfig } from "./serialize.ts";
import {
  ConflictError,
  type CreateModerationConfigInput,
  type ModerationConfig,
  NotFoundError,
} from "./types.ts";

type ModerationConfigServiceDeps = {
  repo: ModerationConfigRepository;
  cache: ModerationConfigCache;
};

export class ModerationConfigService {
  constructor(private readonly deps: ModerationConfigServiceDeps) {}

  async getActive(): Promise<ModerationConfig> {
    return this.deps.cache.getActive();
  }

  async findByVersion(version: string): Promise<ModerationConfig | null> {
    const row = await this.deps.repo.findByVersion(version);
    return row ? toModerationConfig(row) : null;
  }

  async listHistory(limit: number): Promise<ModerationConfig[]> {
    const rows = await this.deps.repo.listHistory(limit);
    return rows.map(toModerationConfig);
  }

  async createConfig(input: CreateModerationConfigInput): Promise<ModerationConfig> {
    if (await this.deps.repo.existsByVersion(input.version)) {
      throw new ConflictError(`Version "${input.version}" já existe`);
    }

    const contentHash = hashConfig(input);
    await this.warnIfContentHashReused(contentHash, input.version);

    const row: NewModerationConfigRow = {
      version: input.version,
      primaryModel: input.primaryModel,
      escalationModel: input.escalationModel ?? null,
      escalationThreshold:
        input.escalationThreshold === undefined || input.escalationThreshold === null
          ? null
          : input.escalationThreshold.toFixed(2),
      escalationCategories: input.escalationCategories ?? [],
      systemPrompt: input.systemPrompt,
      examples: input.examples ?? [],
      contentHash,
    };

    const inserted = await this.insertAndActivate(row);
    await this.deps.cache.invalidate();

    return toModerationConfig(inserted);
  }

  async activate(version: string): Promise<ModerationConfig> {
    const result = await this.deps.repo.withTransaction((tx) =>
      this.deps.repo.activateByVersion(version, tx)
    );

    if (!result) {
      throw new NotFoundError(`Version "${version}" não encontrada em moderation_configs`);
    }

    await this.deps.cache.invalidate();
    return toModerationConfig(result);
  }

  private async insertAndActivate(row: NewModerationConfigRow): Promise<ModerationConfigRow> {
    try {
      return await this.deps.repo.withTransaction((tx) =>
        this.deps.repo.insertAndActivate(row, tx)
      );
    } catch (err) {
      if (isUniqueViolationOnVersion(err)) {
        throw new ConflictError(`Version "${row.version}" já existe`);
      }
      throw err;
    }
  }

  private async warnIfContentHashReused(hash: string, version: string): Promise<void> {
    const existing = await this.deps.repo.listHistory(50);
    const sameHash = existing.find((r) => r.contentHash === hash);
    if (sameHash) {
      logger.warn(
        { version, duplicateOf: sameHash.version, contentHash: hash },
        "Nova moderation-config tem mesmo contentHash de versão anterior — bump sem mudança real"
      );
    }
  }
}

/**
 * Content hash determinístico do payload efetivo (campos que afetam moderação).
 * Ordena keys e normaliza números para estabilidade.
 */
function hashConfig(input: CreateModerationConfigInput): string {
  const normalized = JSON.stringify({
    primaryModel: input.primaryModel,
    escalationModel: input.escalationModel ?? null,
    escalationThreshold:
      input.escalationThreshold === undefined || input.escalationThreshold === null
        ? null
        : Number(input.escalationThreshold),
    escalationCategories: [...(input.escalationCategories ?? [])].sort(),
    systemPrompt: input.systemPrompt,
    examples: input.examples ?? [],
  });
  return createHash("sha256").update(normalized).digest("hex");
}

// Nome vem da migration 0007_familiar_corsair.sql (CONSTRAINT
// `moderation_configs_version_unique`). Se renomear o constraint numa migration
// futura, atualizar o regex aqui — o teste de race em `moderation-config-service.test.ts`
// depende desse match.
function isUniqueViolationOnVersion(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return /moderation_configs_version_unique|duplicate key.*version/i.test(msg);
}
