import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
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

  async listExternalIdsByProtocol(protocol: Protocol): Promise<string[]> {
    const rows = await this.db
      .select({ externalId: messagingGroups.externalId })
      .from(messagingGroups)
      .where(eq(messagingGroups.protocol, protocol));
    return rows.map((r) => r.externalId);
  }
}
