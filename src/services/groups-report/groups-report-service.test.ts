import { describe, expect, it, mock } from "bun:test";
import type { Db } from "../../db/client.ts";
import type { MessagingProviderInstanceService } from "../messaging-provider-instance/index.ts";
import type { InstanceView } from "../messaging-provider-instance/types.ts";
import { GroupsReportService } from "./groups-report-service.ts";

const PROVIDER_INSTANCE = "11111111-1111-1111-1111-111111111111";

function makeInstanceView(overrides: Partial<InstanceView["zapi"]> = null as never): InstanceView {
  return {
    id: PROVIDER_INSTANCE,
    protocol: "whatsapp",
    providerKind: "whatsapp_zapi",
    displayName: "Test",
    isEnabled: false,
    executionStrategy: "leased",
    redisKey: "messaging:whatsapp",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    zapi: overrides
      ? ({
          zapiInstanceId: "z",
          instanceTokenMasked: "***",
          customClientTokenMasked: null,
          currentConnectionState: null,
          currentConnected: null,
          currentPhoneNumber: null,
          lastStatusSyncedAt: null,
          ...overrides,
        } as InstanceView["zapi"])
      : null,
  };
}

function makeInstanceService(view: InstanceView | null) {
  return {
    get: mock(() => Promise.resolve(view)),
  } as unknown as MessagingProviderInstanceService;
}

// Builder de Db: stub do query builder do drizzle-orm. Cada `select(...)` retorna
// um chainable que termina resolvendo na lista de rows pré-configurada na ordem
// de chamada. Um array de "respostas" por chamada permite dois selects distintos.
function makeDb(rowsPerSelect: unknown[][]): Db {
  let callIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = rowsPerSelect[callIndex++] ?? [];
          return Promise.resolve(rows);
        },
      }),
    }),
  } as unknown as Db;
}

describe("GroupsReportService.buildReport", () => {
  it("instance_not_found quando instanceService.get retorna null", async () => {
    const svc = new GroupsReportService({
      db: makeDb([]),
      instanceService: makeInstanceService(null),
    });
    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("instance_not_found");
  });

  it("instance_missing_phone quando zapi.currentPhoneNumber é null", async () => {
    const view = makeInstanceView({ currentPhoneNumber: null } as never);
    const svc = new GroupsReportService({
      db: makeDb([]),
      instanceService: makeInstanceService(view),
    });
    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.kind).toBe("instance_missing_phone");
  });

  it("retorna counts agregados — missingFromGroups vem da própria query (NOT EXISTS)", async () => {
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const lastSyncedAt = new Date("2025-01-15T12:00:00.000Z");
    const svc = new GroupsReportService({
      db: makeDb([
        // primeiro select: messaging_groups counts (4 contagens + lastSyncedAt)
        [
          {
            totalGroups: 100,
            groupsWithInviteUrl: 80,
            groupsWithInstance: 60,
            missingFromGroups: 25,
            lastSyncedAt,
          },
        ],
        // segundo select: groupsAsAdmin
        [{ groupsAsAdmin: 5 }],
        // terceiro select: lista detalhada de missingGroups
        [],
      ]),
      instanceService: makeInstanceService(view),
    });

    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.instanceWaId).toBe("5511999990001@s.whatsapp.net");
      expect(out.report.totalGroups).toBe(100);
      expect(out.report.groupsWithInviteUrl).toBe(80);
      expect(out.report.groupsWithInstance).toBe(60);
      expect(out.report.groupsAsAdmin).toBe(5);
      // 25 reflete a verdade (NOT EXISTS), não 80-60=20 — instância pode estar
      // em grupos sem invite_url e a subtração antiga underestimaria.
      expect(out.report.missingFromGroups).toBe(25);
      expect(out.report.lastSyncedAt).toBe("2025-01-15T12:00:00.000Z");
    }
  });

  it("missingFromGroups consistente quando instância está em grupos sem invite_url", async () => {
    // Cenário que a versão antiga mascarava: instância em 100 grupos (60 com invite,
    // 40 sem). 80 grupos têm invite no total. Versão antiga: max(0, 80-100)=0.
    // Versão nova: NOT EXISTS conta os 20 com invite onde a instância não está.
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const svc = new GroupsReportService({
      db: makeDb([
        [
          {
            totalGroups: 120,
            groupsWithInviteUrl: 80,
            groupsWithInstance: 100,
            missingFromGroups: 20,
            lastSyncedAt: null,
          },
        ],
        [{ groupsAsAdmin: 0 }],
        [],
      ]),
      instanceService: makeInstanceService(view),
    });

    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.missingFromGroups).toBe(20);
      // Sanity: groupsWithInstance (100) > groupsWithInviteUrl (80) é cenário válido
      // — só significa que a instância foi adicionada manualmente a grupos sem link.
      expect(out.report.groupsWithInstance).toBe(100);
    }
  });

  it("propaga 0 quando query retorna linha vazia", async () => {
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const svc = new GroupsReportService({
      db: makeDb([[], [], []]),
      instanceService: makeInstanceService(view),
    });

    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.totalGroups).toBe(0);
      expect(out.report.groupsWithInviteUrl).toBe(0);
      expect(out.report.groupsWithInstance).toBe(0);
      expect(out.report.groupsAsAdmin).toBe(0);
      expect(out.report.missingFromGroups).toBe(0);
      expect(out.report.missingGroups).toEqual([]);
      expect(out.report.lastSyncedAt).toBeNull();
    }
  });

  it("missingGroups inclui {id,name,inviteUrl} dos grupos faltantes", async () => {
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const missing = [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        name: "Grupo SP",
        inviteUrl: "https://chat.whatsapp.com/AAA",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        name: "Grupo RJ",
        inviteUrl: "https://chat.whatsapp.com/BBB",
      },
    ];
    const svc = new GroupsReportService({
      db: makeDb([
        [
          {
            totalGroups: 10,
            groupsWithInviteUrl: 5,
            groupsWithInstance: 3,
            missingFromGroups: 2,
            lastSyncedAt: null,
          },
        ],
        [{ groupsAsAdmin: 0 }],
        missing,
      ]),
      instanceService: makeInstanceService(view),
    });

    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.missingGroups).toEqual(missing);
      // invariante: lista detalhada e contador vêm do mesmo predicado
      expect(out.report.missingGroups.length).toBe(out.report.missingFromGroups);
    }
  });
});
