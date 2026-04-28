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

  it("retorna counts agregados com cálculo de missingFromGroups", async () => {
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const lastSyncedAt = new Date("2025-01-15T12:00:00.000Z");
    const svc = new GroupsReportService({
      db: makeDb([
        // primeiro select: messaging_groups counts
        [{ totalGroups: 100, groupsWithInviteUrl: 80, lastSyncedAt }],
        // segundo select: presence
        [{ groupsWithInstance: 60, groupsAsAdmin: 5 }],
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
      expect(out.report.missingFromGroups).toBe(20); // 80 - 60
      expect(out.report.lastSyncedAt).toBe("2025-01-15T12:00:00.000Z");
    }
  });

  it("missingFromGroups nunca fica negativo (defensivo)", async () => {
    const view = makeInstanceView({ currentPhoneNumber: "5511999990001" } as never);
    const svc = new GroupsReportService({
      db: makeDb([
        [{ totalGroups: 5, groupsWithInviteUrl: 5, lastSyncedAt: null }],
        // mais "presença" que invite_url (caso exotérico de inconsistência)
        [{ groupsWithInstance: 10, groupsAsAdmin: 0 }],
      ]),
      instanceService: makeInstanceService(view),
    });

    const out = await svc.buildReport(PROVIDER_INSTANCE);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.missingFromGroups).toBe(0);
    }
  });
});
