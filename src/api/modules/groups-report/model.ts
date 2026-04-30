import { Elysia, t } from "elysia";

export const groupsReportModel = new Elysia({ name: "groupsReportModel" }).model({
  "groupsReport.response": t.Object({
    providerInstanceId: t.String({ format: "uuid" }),
    instanceWaId: t.Union([t.String(), t.Null()]),
    totalGroups: t.Integer(),
    groupsWithInviteUrl: t.Integer(),
    groupsWithInstance: t.Integer(),
    groupsAsAdmin: t.Integer(),
    missingFromGroups: t.Integer(),
    missingGroups: t.Array(
      t.Object({
        id: t.String({ format: "uuid" }),
        name: t.String(),
        inviteUrl: t.String(),
      })
    ),
    lastSyncedAt: t.Union([t.String(), t.Null()]),
  }),
});
