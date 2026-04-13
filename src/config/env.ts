import { z } from "zod";

// Schema de uma única instância da Z-API
const zapiInstanceSchema = z.object({
  instance_id: z.string().min(1),
  instance_token: z.string().min(1),
  client_token: z.string().min(1),
});

// Faz o parse da env var ZAPI_INSTANCES, que é uma string JSON com array de objetos
const zapiInstancesSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ZAPI_INSTANCES deve ser um JSON válido",
      });
      return z.NEVER;
    }
  })
  .pipe(
    z.array(zapiInstanceSchema).min(1, {
      message: "ZAPI_INSTANCES deve conter pelo menos uma instância",
    })
  );

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, { message: "DATABASE_URL é obrigatória" }),

  AMQP_URL: z.string().url({ message: "AMQP_URL deve ser uma URL válida" }),
  AMQP_QUEUE: z.string().min(1),
  AMQP_PREFETCH: z.coerce.number().int().positive().default(5),

  ZAPI_BASE_URL: z.string().url({ message: "ZAPI_BASE_URL deve ser uma URL válida" }),
  ZAPI_INSTANCES: zapiInstancesSchema,

  // Concorrência por instância — total = concurrencyPerInstance × instances.length
  ZAPI_CONCURRENCY_PER_INSTANCE: z.coerce.number().int().positive().default(1),

  // Delay aleatório (ms) entre requisições — cria jitter para evitar rajadas
  ZAPI_DELAY_MIN_MS: z.coerce.number().int().nonnegative().default(500),
  ZAPI_DELAY_MAX_MS: z.coerce.number().int().nonnegative().default(1800),

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
