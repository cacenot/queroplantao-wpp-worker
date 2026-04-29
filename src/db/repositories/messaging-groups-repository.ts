import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { groupParticipants } from "../schema/group-participants.ts";
import {
  type MessagingGroup,
  messagingGroups,
  type NewMessagingGroup,
} from "../schema/messaging-groups.ts";
import type { messagingProtocolEnum } from "../schema/provider-registry.ts";

type Protocol = (typeof messagingProtocolEnum.enumValues)[number];

export class MessagingGroupsRepository {
  constructor(private readonly db: Db) {}

  async upsertMany(rows: NewMessagingGroup[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };

    const returned = await this.db
      .insert(messagingGroups)
      .values(rows)
      .onConflictDoUpdate({
        target: [messagingGroups.externalId, messagingGroups.protocol],
        set: {
          protocol: sql`excluded.protocol`,
          name: sql`excluded.name`,
          inviteUrl: sql`excluded.invite_url`,
          imageUrl: sql`excluded.image_url`,
          country: sql`excluded.country`,
          uf: sql`excluded.uf`,
          region: sql`excluded.region`,
          city: sql`excluded.city`,
          specialties: sql`excluded.specialties`,
          categories: sql`excluded.categories`,
          participantCount: sql`excluded.participant_count`,
          isCommunityVisible: sql`excluded.is_community_visible`,
          metadata: sql`excluded.metadata`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          syncedAt: sql`excluded.synced_at`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`
          excluded.name                IS DISTINCT FROM ${messagingGroups.name}      OR
          excluded.invite_url          IS DISTINCT FROM ${messagingGroups.inviteUrl} OR
          excluded.image_url           IS DISTINCT FROM ${messagingGroups.imageUrl}  OR
          excluded.country             IS DISTINCT FROM ${messagingGroups.country}   OR
          excluded.uf                  IS DISTINCT FROM ${messagingGroups.uf}        OR
          excluded.region              IS DISTINCT FROM ${messagingGroups.region}    OR
          excluded.city                IS DISTINCT FROM ${messagingGroups.city}      OR
          excluded.specialties         IS DISTINCT FROM ${messagingGroups.specialties}         OR
          excluded.categories          IS DISTINCT FROM ${messagingGroups.categories}          OR
          excluded.participant_count   IS DISTINCT FROM ${messagingGroups.participantCount}    OR
          excluded.is_community_visible IS DISTINCT FROM ${messagingGroups.isCommunityVisible} OR
          excluded.metadata            IS DISTINCT FROM ${messagingGroups.metadata}            OR
          excluded.source_updated_at   IS DISTINCT FROM ${messagingGroups.sourceUpdatedAt}
        `,
      })
      .returning({
        id: messagingGroups.id,
        isNew: sql<boolean>`(xmax::text::int = 0)`,
      });

    const inserted = returned.filter((r) => r.isNew).length;
    return { inserted, updated: returned.length - inserted };
  }

  async findByExternalId(externalId: string, protocol?: Protocol): Promise<MessagingGroup | null> {
    const condition = protocol
      ? and(eq(messagingGroups.externalId, externalId), eq(messagingGroups.protocol, protocol))
      : eq(messagingGroups.externalId, externalId);

    const [row] = await this.db.select().from(messagingGroups).where(condition).limit(1);
    return row ?? null;
  }

  async listByProtocol(protocol: Protocol): Promise<MessagingGroup[]> {
    return this.db.select().from(messagingGroups).where(eq(messagingGroups.protocol, protocol));
  }

  /**
   * Lista grupos do protocolo cujo `synced_at < syncedBefore` (ou nulo).
   * Usado pelo CLI de sync para evitar re-trabalho em grupos sincronizados
   * recentemente. Ordena por `synced_at ASC` para priorizar os mais defasados.
   */
  async listStaleByProtocol(args: {
    protocol: Protocol;
    syncedBefore: Date;
    limit?: number;
  }): Promise<MessagingGroup[]> {
    const where = and(
      eq(messagingGroups.protocol, args.protocol),
      or(isNull(messagingGroups.syncedAt), lt(messagingGroups.syncedAt, args.syncedBefore))
    );
    const base = this.db
      .select()
      .from(messagingGroups)
      .where(where)
      .orderBy(asc(messagingGroups.syncedAt));
    return args.limit !== undefined ? base.limit(args.limit) : base;
  }

  async listExternalIdsByProtocol(protocol: Protocol): Promise<string[]> {
    const rows = await this.db
      .select({ externalId: messagingGroups.externalId })
      .from(messagingGroups)
      .where(eq(messagingGroups.protocol, protocol));
    return rows.map((r) => r.externalId);
  }

  /**
   * Lista grupos onde a instância (identificada pelo `wa_id` canonical) **não** está
   * presente como participante ativo, e que possuem `invite_url` (i.e., podemos
   * tentar entrar via accept-group-invite). Ordenado por `created_at ASC` —
   * primeiros pendentes primeiro, com `limit` controlando o batch.
   */
  async listMissingForInstance(args: {
    protocol: Protocol;
    instanceWaId: string;
    limit: number;
  }): Promise<MessagingGroup[]> {
    const present = this.db
      .select({ groupExternalId: groupParticipants.groupExternalId })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.protocol, args.protocol),
          eq(groupParticipants.waId, args.instanceWaId),
          eq(groupParticipants.status, "active")
        )
      );

    return this.db
      .select()
      .from(messagingGroups)
      .where(
        and(
          eq(messagingGroups.protocol, args.protocol),
          isNotNull(messagingGroups.inviteUrl),
          sql`${messagingGroups.externalId} NOT IN ${present}`
        )
      )
      .orderBy(asc(messagingGroups.createdAt))
      .limit(args.limit);
  }

  /**
   * Atualiza `participant_count` e `synced_at` após sync de participantes via
   * `/light-group-metadata`. Não toca campos que vêm do admin API (name, invite_url, etc.).
   */
  async updateSyncSnapshot(args: {
    externalId: string;
    protocol: Protocol;
    participantCount: number;
    syncedAt: Date;
  }): Promise<void> {
    await this.db
      .update(messagingGroups)
      .set({
        participantCount: args.participantCount,
        syncedAt: args.syncedAt,
        updatedAt: args.syncedAt,
      })
      .where(
        and(
          eq(messagingGroups.externalId, args.externalId),
          eq(messagingGroups.protocol, args.protocol)
        )
      );
  }
}
