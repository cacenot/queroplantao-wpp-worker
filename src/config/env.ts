import { z } from "zod";

const envSchema = z.object({
  // ─── DATABASE ────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, { message: "DATABASE_URL é obrigatória" }),

  // ─── AMQP ────────────────────────────────────────────────────────────────────
  AMQP_URL: z.string().url({ message: "AMQP_URL deve ser uma URL válida" }),
  // Fila do whatsapp-zapi worker (delete_message + remove_participant). Usa x-max-priority=10
  // pra garantir delete (priority 10) antes de remove (priority 7).
  AMQP_ZAPI_QUEUE: z.string().min(1).default("messaging.zapi"),
  // Prefetch zapi: 1 (serial) — lease Z-API já coordena acesso por provider
  AMQP_ZAPI_PREFETCH: z.coerce.number().int().positive().default(1),
  // Fila do moderation worker (moderate_group_message). Sem priority (um único tipo).
  AMQP_MODERATION_QUEUE: z.string().min(1).default("messaging.moderation"),
  // Prefetch moderation: 5 — LLM é I/O bound e não toca Z-API, paralelismo ok
  AMQP_MODERATION_PREFETCH: z.coerce.number().int().positive().default(5),
  // TTL (ms) da fila de retry — delay antes de cada re-tentativa
  AMQP_RETRY_DELAY_MS: z.coerce.number().int().positive().default(120000),
  // Número máximo de retries antes do DLQ. Total de execuções = maxRetries + 1.
  AMQP_RETRY_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // ─── REDIS ───────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().url({ message: "REDIS_URL deve ser uma URL válida" }),

  // ─── HTTP / WORKER ───────────────────────────────────────────────────────────
  // 0 = porta aleatória, útil em testes
  HTTP_PORT: z.coerce.number().int().nonnegative().default(3000),
  HTTP_API_KEY: z.string().min(1, { message: "HTTP_API_KEY é obrigatória" }),
  // Health server expostos por cada worker (Coolify / Docker HEALTHCHECK).
  // Portas distintas pra evitar EADDRINUSE quando rodando no mesmo host.
  WORKER_ZAPI_HEALTH_PORT: z.coerce.number().int().nonnegative().default(3011),
  WORKER_MODERATION_HEALTH_PORT: z.coerce.number().int().nonnegative().default(3012),

  // ─── Z-API ───────────────────────────────────────────────────────────────────
  ZAPI_BASE_URL: z.string().url({ message: "ZAPI_BASE_URL deve ser uma URL válida" }),
  ZAPI_CLIENT_TOKEN: z.string().min(1, { message: "ZAPI_CLIENT_TOKEN é obrigatória" }),
  // Delay aleatório (ms) entre requisições — cria jitter para evitar rajadas
  ZAPI_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(2500),
  ZAPI_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(5200),
  // TTL (ms) da lease distribuída por provider — protege contra crashes do worker
  ZAPI_SAFETY_TTL_MS: z.coerce.number().int().positive().default(30_000),
  // Intervalo (ms) de renovação da lease — deve ser < ZAPI_SAFETY_TTL_MS
  ZAPI_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  // Timeout (ms) por request HTTP — timeout é retryable (cai na fila de retry)
  ZAPI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ─── WEBHOOKS ────────────────────────────────────────────────────────────────
  ZAPI_RECEIVED_WEBHOOK_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  ZAPI_RECEIVED_WEBHOOK_SECRET: z
    .string()
    .min(1, { message: "ZAPI_RECEIVED_WEBHOOK_SECRET é obrigatória" }),

  // ─── QP ADMIN API ────────────────────────────────────────────────────────────
  QP_ADMIN_API_URL: z.string().url({ message: "QP_ADMIN_API_URL deve ser uma URL válida" }),
  QP_ADMIN_API_TOKEN: z.string().min(1, { message: "QP_ADMIN_API_TOKEN é obrigatória" }),
  QP_ADMIN_API_SERVICE_TOKEN: z
    .string()
    .min(1, { message: "QP_ADMIN_API_SERVICE_TOKEN é obrigatória" }),

  // ─── AI ──────────────────────────────────────────────────────────────────────
  // Lidas implicitamente pelo Vercel AI SDK — apenas o provider ativo precisa estar definido
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  // ─── MODERAÇÃO ───────────────────────────────────────────────────────────────
  // Filtro determinístico de conteúdo — liga via env após 1-2 dias observando o LLM
  MODERATION_CONTENT_FILTER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Enforcement por blacklist (delete + kick em hit). Default true preserva comportamento;
  // desligar via "false" inibe a consulta de blacklist e o ban automático correspondente.
  MODERATION_BLACKLIST_ENFORCEMENT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Janela (ms) do bucket de dedupe de ingestão — colapsa a mesma mensagem em várias instâncias Z-API
  INGESTION_DEDUPE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Janela (ms) de reuso por contentHash + moderationVersion — default: 15 dias
  MODERATION_REUSE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 24 * 60 * 60 * 1000),
  // Prefixo das chaves Redis do cache de grupos monitorados (ex.: `${prefix}:whatsapp`)
  MESSAGING_GROUPS_REDIS_PREFIX: z.string().min(1).default("messaging_groups"),

  // ─── SCRIPTS ─────────────────────────────────────────────────────────────────
  // spam-watcher: lista de filtros separados por vírgula
  SPAM_FILTERS: z.string().optional(),
  // spam-watcher: intervalo entre execuções (ms)
  SPAM_INTERVAL_MS: z.coerce.number().int().positive().default(120000),
  // seed-initial: JSON com provider instances + moderation config (omitir pula criação de instâncias)
  SEED_DATA_JSON: z.string().optional(),

  // ─── SENTRY ──────────────────────────────────────────────────────────────────
  // Sem DSN, init vira no-op (dev local não envia)
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().min(1).default("production"),
  SENTRY_RELEASE: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  [${e.path.join(".")}] ${e.message}`)
      .join("\n");
    throw new Error(`Configuração de ambiente inválida:\n${formatted}`);
  }

  return result.data;
}

// Exportado uma única vez no startup — demais módulos importam daqui
export const env = parseEnv();

export type Env = typeof env;
