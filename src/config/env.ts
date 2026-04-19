import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, { message: "DATABASE_URL é obrigatória" }),

  AMQP_URL: z.string().url({ message: "AMQP_URL deve ser uma URL válida" }),
  AMQP_QUEUE: z.string().min(1),
  AMQP_PREFETCH: z.coerce.number().int().positive().default(5),

  // TTL (ms) da fila de retry. Todo retry espera este delay antes de voltar à fila principal.
  AMQP_RETRY_DELAY_MS: z.coerce.number().int().positive().default(120000),

  // Número máximo de retries antes do DLQ. Total de execuções = maxRetries + 1.
  AMQP_RETRY_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // Nome da fila de mensagens mortas. Default: ${AMQP_QUEUE}.dlq
  AMQP_DLQ_NAME: z.string().optional(),

  ZAPI_BASE_URL: z.string().url({ message: "ZAPI_BASE_URL deve ser uma URL válida" }),
  ZAPI_CLIENT_TOKEN: z.string().min(1, { message: "ZAPI_CLIENT_TOKEN é obrigatória" }),

  // Delay aleatório (ms) entre requisições Z-API — cria jitter para evitar rajadas
  ZAPI_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(2500),
  ZAPI_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(5200),

  // Redis — usado para coordenar rate limiting distribuído entre workers
  REDIS_URL: z.string().url({ message: "REDIS_URL deve ser uma URL válida" }),

  // Servidor HTTP para receber tasks via API (0 = porta aleatória, útil em testes)
  HTTP_PORT: z.coerce.number().int().nonnegative().default(3000),
  HTTP_API_KEY: z.string().min(1, { message: "HTTP_API_KEY é obrigatória" }),

  // Porta do health check do worker (separada da API)
  WORKER_HEALTH_PORT: z.coerce.number().int().nonnegative().default(3001),

  // QP Admin API — usada para persistir resultados de análise de mensagens
  QP_ADMIN_API_URL: z.string().url({ message: "QP_ADMIN_API_URL deve ser uma URL válida" }),
  QP_ADMIN_API_TOKEN: z.string().min(1, { message: "QP_ADMIN_API_TOKEN é obrigatória" }),

  // AI — chaves de API (opcionais — apenas a do provider ativo precisa estar definida)
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),

  // AI — modelo por action (formato: "provider/model-name")
  AI_MODEL_ANALYZE_MESSAGE: z.string().min(1).default("openai/gpt-4o-mini"),

  // Moderação — versão ativa do prompt/regras. Bumpar invalida cache de reuso.
  MODERATION_VERSION: z.string().min(1, { message: "MODERATION_VERSION é obrigatória" }),

  // Janela (ms) do bucket de dedupe de ingestão. Colapsa a mesma mensagem em várias instâncias Z-API.
  INGESTION_DEDUPE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Janela (ms) de reuso de moderação por contentHash + moderationVersion. Default: 15 dias.
  MODERATION_REUSE_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 24 * 60 * 60 * 1000),

  // Prefixo das chaves Redis do cache de grupos monitorados (ex.: `${prefix}:whatsapp`).
  MESSAGING_GROUPS_REDIS_PREFIX: z.string().min(1).default("messaging_groups"),

  // Webhook público Z-API `on-message-received`.
  ZAPI_RECEIVED_WEBHOOK_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  ZAPI_RECEIVED_WEBHOOK_SECRET: z
    .string()
    .min(1, { message: "ZAPI_RECEIVED_WEBHOOK_SECRET é obrigatória" }),

  // spam-watcher: lista de filtros separados por vírgula (opcional — só usado pelo script)
  SPAM_FILTERS: z.string().optional(),
  // spam-watcher: intervalo entre execuções em ms (default: 2 min)
  SPAM_INTERVAL_MS: z.coerce.number().int().positive().default(120000),
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
