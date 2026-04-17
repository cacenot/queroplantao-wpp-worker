import type { MessagingGroupsRepository } from "../../db/repositories/messaging-groups-repository.ts";
import type { NewMessagingGroup } from "../../db/schema/messaging-groups.ts";
import { logger } from "../../lib/logger.ts";
import type { AdminMessagingGroup, QpAdminApiClient } from "../../lib/qp-admin-api.ts";
import type { MessagingGroupsCache } from "./messaging-groups-cache.ts";

interface GroupSyncServiceOptions {
  adminApi: QpAdminApiClient;
  repo: MessagingGroupsRepository;
  cache: MessagingGroupsCache;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
}

export class GroupSyncService {
  private readonly adminApi: QpAdminApiClient;
  private readonly repo: MessagingGroupsRepository;
  private readonly cache: MessagingGroupsCache;

  constructor(options: GroupSyncServiceOptions) {
    this.adminApi = options.adminApi;
    this.repo = options.repo;
    this.cache = options.cache;
  }

  async syncFromAdminApi(): Promise<SyncResult> {
    let remote: AdminMessagingGroup[];
    try {
      remote = await this.adminApi.listMessagingGroups();
    } catch (err) {
      logger.warn({ err }, "Falha ao buscar grupos na admin API — preservando estado local");
      return { fetched: 0, inserted: 0, updated: 0 };
    }

    if (remote.length === 0) {
      logger.warn("Admin API retornou lista vazia — preservando estado local para evitar zerar");
      return { fetched: 0, inserted: 0, updated: 0 };
    }

    const rows: NewMessagingGroup[] = remote.map(toNewMessagingGroup);
    const { inserted, updated } = await this.repo.upsertMany(rows);

    // Rebuild Redis a partir do estado atual do Postgres (não do payload remoto —
    // sync parcial não corrompe o cache).
    await this.rebuildCacheFromDb();

    logger.info(
      { fetched: remote.length, inserted, updated },
      "Sync de grupos monitorados concluído"
    );

    return { fetched: remote.length, inserted, updated };
  }

  async rebuildCacheFromDb(): Promise<void> {
    for (const protocol of ["whatsapp", "telegram"] as const) {
      const ids = await this.repo.listExternalIdsByProtocol(protocol);
      await this.cache.replaceSet(protocol, ids);
    }
  }
}

function toNewMessagingGroup(group: AdminMessagingGroup): NewMessagingGroup {
  const now = new Date();
  return {
    externalId: group.externalId,
    protocol: group.protocol,
    name: group.name,
    inviteUrl: group.inviteUrl,
    imageUrl: group.imageUrl,
    country: group.country,
    uf: group.uf,
    region: group.region,
    city: group.city,
    specialties: group.specialties,
    categories: group.categories,
    participantCount: group.participantCount,
    isCommunityVisible: group.isCommunityVisible,
    metadata: group.metadata,
    sourceUpdatedAt: group.sourceUpdatedAt ? new Date(group.sourceUpdatedAt) : null,
    syncedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
