import { collectDefaultMetrics, Registry } from "prom-client";

// Registry global compartilhado por todo o processo. Cada entrypoint (api,
// worker:zapi, worker:moderation) chama `collectDefaultMetrics` uma única vez
// e expõe `register.metrics()` na rota `/metrics`.
export const register = new Registry();

// Label `service` injetado em todas as métricas — alinha com o `SERVICE_NAME`
// usado pelo Pino e pelo Sentry. Permite filtrar dashboards por serviço sem
// depender do `instance` do scrape.
register.setDefaultLabels({ service: process.env.SERVICE_NAME ?? "unknown" });

let defaultsCollected = false;

// Idempotente — chamado pelos entrypoints. Evita registrar default metrics
// duas vezes (causaria erro do prom-client em testes que importam o módulo
// indiretamente).
export function ensureDefaultMetrics(): void {
  if (defaultsCollected) return;
  collectDefaultMetrics({ register, prefix: "app_" });
  defaultsCollected = true;
}
