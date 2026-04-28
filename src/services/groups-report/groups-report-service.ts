import { and, eq, isNotNull, max, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { groupParticipants } from "../../db/schema/group-participants.ts";
import { messagingGroups } from "../../db/schema/messaging-groups.ts";
import { toWaId } from "../../lib/phone.ts";
import type { MessagingProviderInstanceService } from "../messaging-provider-instance/index.ts";

export type GroupsReport = {
  providerInstanceId: string;
  instanceWaId: string | null;
  totalGroups: number;
  groupsWithInviteUrl: number;
  groupsWithInstance: number;
  groupsAsAdmin: number;
  missingFromGroups: number;
  lastSyncedAt: string | null;
};

export type GroupsReportError = { kind: "instance_not_found" } | { kind: "instance_missing_phone" };

type Outcome = { ok: true; report: GroupsReport } | { ok: false; error: GroupsReportError };

export class GroupsReportService {
  constructor(
    private readonly deps: {
      db: Db;
      instanceService: MessagingProviderInstanceService;
    }
  ) {}

  async buildReport(providerInstanceId: string): Promise<Outcome> {
    const { db, instanceService } = this.deps;

    const instance = await instanceService.get(providerInstanceId);
    if (!instance) return { ok: false, error: { kind: "instance_not_found" } };

    const phone = instance.zapi?.currentPhoneNumber ?? null;
    const waId = toWaId(phone);
    if (!waId) return { ok: false, error: { kind: "instance_missing_phone" } };

    // Counts em messaging_groups (total / com invite / lastSynced).
    const [groupTotals] = await db
      .select({
        totalGroups: sql<number>`count(*)::int`,
        groupsWithInviteUrl: sql<number>`count(*) FILTER (WHERE ${messagingGroups.inviteUrl} IS NOT NULL)::int`,
        lastSyncedAt: max(messagingGroups.syncedAt),
      })
      .from(messagingGroups)
      .where(eq(messagingGroups.protocol, "whatsapp"));

    // Counts da instância em group_participants (presente / admin).
    const [presence] = await db
      .select({
        groupsWithInstance: sql<number>`count(DISTINCT ${groupParticipants.groupExternalId})::int`,
        groupsAsAdmin: sql<number>`count(DISTINCT ${groupParticipants.groupExternalId}) FILTER (WHERE ${groupParticipants.role} IN ('admin', 'owner'))::int`,
      })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.protocol, "whatsapp"),
          eq(groupParticipants.waId, waId),
          eq(groupParticipants.status, "active"),
          isNotNull(groupParticipants.waId)
        )
      );

    const totalGroups = groupTotals?.totalGroups ?? 0;
    const groupsWithInviteUrl = groupTotals?.groupsWithInviteUrl ?? 0;
    const groupsWithInstance = presence?.groupsWithInstance ?? 0;
    const groupsAsAdmin = presence?.groupsAsAdmin ?? 0;

    // "Falta entrar" = grupos com invite e onde a instância não está presente.
    // Usar `groupsWithInviteUrl` como teto (não dá pra entrar onde não tem invite).
    const missingFromGroups = Math.max(0, groupsWithInviteUrl - groupsWithInstance);

    return {
      ok: true,
      report: {
        providerInstanceId,
        instanceWaId: waId,
        totalGroups,
        groupsWithInviteUrl,
        groupsWithInstance,
        groupsAsAdmin,
        missingFromGroups,
        lastSyncedAt:
          groupTotals?.lastSyncedAt instanceof Date
            ? groupTotals.lastSyncedAt.toISOString()
            : (groupTotals?.lastSyncedAt ?? null),
      },
    };
  }
}
