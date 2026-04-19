import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type ModerationConfigRow,
  moderationConfigs,
  type NewModerationConfigRow,
} from "../schema/moderation-configs.ts";

type DbOrTx = Db;

export class ModerationConfigRepository {
  constructor(private readonly db: Db) {}

  async findActive(): Promise<ModerationConfigRow | null> {
    const [row] = await this.db
      .select()
      .from(moderationConfigs)
      .where(eq(moderationConfigs.isActive, true))
      .limit(1);
    return row ?? null;
  }

  async findByVersion(version: string): Promise<ModerationConfigRow | null> {
    const [row] = await this.db
      .select()
      .from(moderationConfigs)
      .where(eq(moderationConfigs.version, version))
      .limit(1);
    return row ?? null;
  }

  async listHistory(limit: number): Promise<ModerationConfigRow[]> {
    return this.db
      .select()
      .from(moderationConfigs)
      .orderBy(desc(moderationConfigs.createdAt))
      .limit(limit);
  }

  /**
   * Insere a nova row já ativa, desativando a anterior na mesma transação.
   * A partial unique `moderation_configs_active_idx` garante atomicidade.
   */
  async insertAndActivate(row: NewModerationConfigRow, tx: DbOrTx): Promise<ModerationConfigRow> {
    await tx
      .update(moderationConfigs)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(moderationConfigs.isActive, true));

    const [inserted] = await tx
      .insert(moderationConfigs)
      .values({ ...row, isActive: true, activatedAt: new Date() })
      .returning();

    if (!inserted) {
      throw new Error("Falha ao inserir moderation_configs — nenhuma linha retornada");
    }

    return inserted;
  }

  /**
   * Flipa `is_active` da row indicada. Retorna `null` se a versão não existe.
   * Caso a row já esteja ativa, é no-op e retorna a row atual.
   */
  async activateByVersion(version: string, tx: DbOrTx): Promise<ModerationConfigRow | null> {
    const target = await tx
      .select()
      .from(moderationConfigs)
      .where(eq(moderationConfigs.version, version))
      .limit(1);

    const [existing] = target;
    if (!existing) return null;
    if (existing.isActive) return existing;

    await tx
      .update(moderationConfigs)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(moderationConfigs.isActive, true));

    const [updated] = await tx
      .update(moderationConfigs)
      .set({ isActive: true, activatedAt: new Date(), updatedAt: new Date() })
      .where(eq(moderationConfigs.version, version))
      .returning();

    return updated ?? null;
  }

  async existsByVersion(version: string, tx?: DbOrTx): Promise<boolean> {
    const executor = tx ?? this.db;
    const [row] = await executor
      .select({ one: sql<number>`1` })
      .from(moderationConfigs)
      .where(eq(moderationConfigs.version, version))
      .limit(1);
    return Boolean(row);
  }

  async withTransaction<T>(fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(tx as unknown as DbOrTx));
  }
}
