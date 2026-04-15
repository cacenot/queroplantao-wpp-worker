import type { MessageAnalysis } from "../../ai/moderator.ts";
import type { AnalyzeMessagePayload } from "../../jobs/types.ts";
import type { QpAdminApiClient } from "../../lib/qp-admin-api.ts";

type ClassifyFn = (text: string) => Promise<MessageAnalysis>;

export async function analyzeMessage(
  payload: AnalyzeMessagePayload,
  classify: ClassifyFn,
  apiClient: QpAdminApiClient
): Promise<void> {
  const analysis = await classify(payload.text);
  await apiClient.submitMessageAnalysis(payload.hash, analysis);
}
