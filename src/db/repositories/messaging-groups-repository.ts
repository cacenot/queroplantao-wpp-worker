import { eq, sql } from "drizzle-orm";
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
        target: messagingGroups.externalId,
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
        createdAt: messagingGroups.createdAt,
        updatedAt: messagingGroups.updatedAt,
      });

    let inserted = 0;
    for (const row of returned) {
      // Se createdAt === updatedAt (na tolerância de ms) foi INSERT; caso contrário UPDATE
      if (row.createdAt.getTime() === row.updatedAt.getTime()) inserted++;
    }

    return { inserted, updated: returned.length - inserted };
  }

  async findByExternalId(externalId: string): Promise<MessagingGroup | null> {
    const [row] = await this.db
      .select()
      .from(messagingGroups)
      .where(eq(messagingGroups.externalId, externalId))
      .limit(1);
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
