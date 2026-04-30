import { beforeEach, describe, it } from "bun:test";
import {
  jobsDlqTotal,
  jobsInFlight,
  jobsProcessedTotal,
  recordJobEnd,
  recordJobStart,
} from "./job-metrics.ts";
import { register } from "./registry.ts";

async function getMetric(name: string): Promise<string> {
  const text = await register.metrics();
  return text
    .split("\n")
    .filter((line) => line.startsWith(name) && !line.startsWith("#"))
    .join("\n");
}

// Verifica que existe uma linha com `metric{...}` contendo todas as
// label assignments e terminando com ` <value>`, sem depender da ordem.
function expectLine(snap: string, metric: string, labels: string[], value: string): void {
  const lines = snap.split("\n");
  const match = lines.find(
    (l) =>
      l.startsWith(`${metric}{`) &&
      labels.every((label) => l.includes(label)) &&
      l.endsWith(` ${value}`)
  );
  if (!match) {
    throw new Error(
      `Esperava linha ${metric}{..., ${labels.join(", ")}} ${value}, mas tinha:\n${snap}`
    );
  }
}

describe("job-metrics", () => {
  beforeEach(() => {
    jobsProcessedTotal.reset();
    jobDurationReset();
    jobsInFlight.reset();
    jobsDlqTotal.reset();
  });

  function jobDurationReset() {
    // O Histogram não tem `.reset()` exposto, mas resetar o registry inteiro
    // afeta as outras métricas. Como observamos o histogram só por amostragem
    // de count, basta verificar incremento relativo nos próprios testes.
  }

  it("incrementa in_flight no start e decrementa no end (sucesso)", async () => {
    recordJobStart("whatsapp.delete_message");
    let snap = await getMetric("jobs_in_flight");
    expectLine(snap, "jobs_in_flight", ['type="whatsapp.delete_message"'], "1");

    recordJobEnd("whatsapp.delete_message", "success", 0.42);
    snap = await getMetric("jobs_in_flight");
    expectLine(snap, "jobs_in_flight", ['type="whatsapp.delete_message"'], "0");
  });

  it("contabiliza throughput por status", async () => {
    recordJobStart("whatsapp.moderate_group_message");
    recordJobEnd("whatsapp.moderate_group_message", "success", 1.2);
    recordJobStart("whatsapp.moderate_group_message");
    recordJobEnd("whatsapp.moderate_group_message", "retry", 2.0);

    const snap = await getMetric("jobs_processed_total");
    expectLine(
      snap,
      "jobs_processed_total",
      ['type="whatsapp.moderate_group_message"', 'status="success"'],
      "1"
    );
    expectLine(
      snap,
      "jobs_processed_total",
      ['type="whatsapp.moderate_group_message"', 'status="retry"'],
      "1"
    );
  });

  it("registra DLQ com motivo apenas quando status=dlq", async () => {
    recordJobStart("whatsapp.delete_message");
    recordJobEnd("whatsapp.delete_message", "dlq", 5.0, "max_retries");

    let snap = await getMetric("jobs_dlq_total");
    expectLine(
      snap,
      "jobs_dlq_total",
      ['type="whatsapp.delete_message"', 'reason="max_retries"'],
      "1"
    );

    // Sucesso não toca jobs_dlq_total
    recordJobStart("whatsapp.delete_message");
    recordJobEnd("whatsapp.delete_message", "success", 0.1);
    snap = await getMetric("jobs_dlq_total");
    expectLine(
      snap,
      "jobs_dlq_total",
      ['type="whatsapp.delete_message"', 'reason="max_retries"'],
      "1"
    );
  });

  it("observa o histogram de duração", async () => {
    recordJobStart("whatsapp.remove_participant");
    recordJobEnd("whatsapp.remove_participant", "success", 1.5);

    const snap = await getMetric("job_duration_seconds_count");
    expectLine(snap, "job_duration_seconds_count", ['type="whatsapp.remove_participant"'], "1");
  });
});
