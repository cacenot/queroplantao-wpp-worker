import { and, eq, sql } from "drizzle-orm";
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

    // Subquery reutilizada nos dois FILTER: "instância está em messaging_groups.external_id?".
    // Mantém o cálculo de `missingFromGroups` consistente com `listMissingForInstance`
    // (mesmo predicado NOT EXISTS) — sem isso, presença em grupos sem invite_url
    // distorceria a subtração aritmética.
    const presentSubquery = sql`EXISTS (
      SELECT 1 FROM ${groupParticipants} gp
      WHERE gp.group_external_id = ${messagingGroups.externalId}
        AND gp.protocol = 'whatsapp'
        AND gp.status = 'active'
        AND gp.wa_id = ${waId}
    )`;

    const [groupTotals] = await db
      .select({
        totalGroups: sql<number>`count(*)::int`,
        groupsWithInviteUrl: sql<number>`count(*) FILTER (WHERE ${messagingGroups.inviteUrl} IS NOT NULL)::int`,
        groupsWithInstance: sql<number>`count(*) FILTER (WHERE ${presentSubquery})::int`,
        missingFromGroups: sql<number>`count(*) FILTER (WHERE ${messagingGroups.inviteUrl} IS NOT NULL AND NOT ${presentSubquery})::int`,
        lastSyncedAt: sql<Date | string | null>`max(${messagingGroups.syncedAt})`,
      })
      .from(messagingGroups)
      .where(eq(messagingGroups.protocol, "whatsapp"));

    // groupsAsAdmin é por participação (não por grupo) — fica em query separada
    // porque exige FROM group_participants, não messaging_groups.
    const [presence] = await db
      .select({
        groupsAsAdmin: sql<number>`count(DISTINCT ${groupParticipants.groupExternalId})::int`,
      })
      .from(groupParticipants)
      .where(
        and(
          eq(groupParticipants.protocol, "whatsapp"),
          eq(groupParticipants.waId, waId),
          eq(groupParticipants.status, "active"),
          sql`${groupParticipants.role} IN ('admin', 'owner')`
        )
      );

    const lastSyncedAtRaw = groupTotals?.lastSyncedAt ?? null;
    return {
      ok: true,
      report: {
        providerInstanceId,
        instanceWaId: waId,
        totalGroups: groupTotals?.totalGroups ?? 0,
        groupsWithInviteUrl: groupTotals?.groupsWithInviteUrl ?? 0,
        groupsWithInstance: groupTotals?.groupsWithInstance ?? 0,
        groupsAsAdmin: presence?.groupsAsAdmin ?? 0,
        missingFromGroups: groupTotals?.missingFromGroups ?? 0,
        lastSyncedAt:
          lastSyncedAtRaw instanceof Date ? lastSyncedAtRaw.toISOString() : lastSyncedAtRaw,
      },
    };
  }
}
