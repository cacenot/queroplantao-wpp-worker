import { Counter, Gauge, Histogram } from "prom-client";
import { register } from "./registry.ts";

export type JobStatus = "success" | "retry" | "dlq";
export type DlqReason = "max_retries" | "non_retryable" | "schema_invalid";

export const jobsProcessedTotal = new Counter({
  name: "jobs_processed_total",
  help: "Total de jobs processados, segmentado por tipo e desfecho final",
  labelNames: ["type", "status"] as const,
  registers: [register],
});

export const jobDurationSeconds = new Histogram({
  name: "job_duration_seconds",
  help: "Duração da execução de um job (do recebimento ao desfecho)",
  labelNames: ["type"] as const,
  // Buckets dimensionados para o range típico desses jobs:
  // - moderation (LLM): 0.5s–10s
  // - zapi (HTTP + delays): 1s–30s
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const jobsInFlight = new Gauge({
  name: "jobs_in_flight",
  help: "Jobs atualmente em execução, segmentado por tipo",
  labelNames: ["type"] as const,
  registers: [register],
});

export const jobsDlqTotal = new Counter({
  name: "jobs_dlq_total",
  help: "Jobs enviados para DLQ, segmentado por tipo e motivo",
  labelNames: ["type", "reason"] as const,
  registers: [register],
});

export function recordJobStart(type: string): void {
  jobsInFlight.inc({ type });
}

// Chamado uma única vez por job no desfecho final (sucesso, retry ou dlq).
// Sempre observa o histogram e decrementa o gauge — `reason` só é relevante
// quando `status === "dlq"`.
export function recordJobEnd(
  type: string,
  status: JobStatus,
  durationSeconds: number,
  reason?: DlqReason
): void {
  jobsProcessedTotal.inc({ type, status });
  jobDurationSeconds.observe({ type }, durationSeconds);
  jobsInFlight.dec({ type });
  if (status === "dlq" && reason) {
    jobsDlqTotal.inc({ type, reason });
  }
}
