import { Elysia, t } from "elysia";
import type { GroupsReportService } from "../../../services/groups-report/index.ts";
import { authPlugin } from "../../shared/auth.ts";
import { errorResponseSchema } from "../../shared/error-envelope.ts";
import { groupsReportModel } from "./model.ts";

export interface GroupsReportModuleDeps {
  groupsReportService: GroupsReportService;
}

export function groupsReportModule(deps: GroupsReportModuleDeps) {
  const { groupsReportService } = deps;

  return new Elysia({ name: "groups-report-module", tags: ["groups"] })
    .use(authPlugin)
    .use(groupsReportModel)
    .get(
      "/instances/:id/groups/report",
      async ({ params, set }) => {
        const outcome = await groupsReportService.buildReport(params.id);
        if (!outcome.ok) {
          if (outcome.error.kind === "instance_not_found") {
            set.status = 404;
            return { error: "Instance not found" };
          }
          set.status = 422;
          return {
            error: "Instance has no current phone — refresh the snapshot before requesting report",
          };
        }
        return outcome.report;
      },
      {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
        response: {
          200: "groupsReport.response",
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
        detail: {
          summary: "Conta grupos onde a instância está, é admin e quantos faltam entrar",
        },
      }
    );
}
