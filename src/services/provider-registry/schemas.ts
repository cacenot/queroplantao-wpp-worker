import { z } from "zod";

export const executionStrategySchema = z.enum(["leased", "passthrough"]);

export const zapiProviderRegistryRowSchema = z.object({
  providerId: z.guid(),
  displayName: z.string().min(1),
  executionStrategy: executionStrategySchema,
  redisKey: z.string().min(1),
  instanceId: z.string().min(1),
  instanceToken: z.string().min(1),
  customClientToken: z.string().min(1).nullable(),
});

export const zapiProviderRegistryRowsSchema = z.array(zapiProviderRegistryRowSchema);

export const zapiStatusSnapshotSchema = z.object({
  connected: z.boolean(),
  error: z.string().min(1).nullable().optional(),
  smartphoneConnected: z.boolean(),
});

export const zapiDeviceSnapshotSchema = z.object({
  phone: z.string().min(1).nullable().optional(),
  imgUrl: z.string().min(1).nullable().optional(),
  about: z.string().min(1).nullable().optional(),
  name: z.string().min(1).nullable().optional(),
  device: z
    .object({
      sessionName: z.string().min(1).nullable().optional(),
      device_model: z.string().min(1).nullable().optional(),
    })
    .nullable()
    .optional(),
  originalDevice: z.string().min(1).nullable().optional(),
  sessionId: z.number().int().nullable().optional(),
  isBusiness: z.boolean().nullable().optional(),
});

// Retorno de GET /me — dados da conta WhatsApp associada à instância Z-API.
// Campos são opcionais porque a resposta varia quando a instância não está conectada.
export const zapiMeSnapshotSchema = z.object({
  phone: z.string().min(1).nullable().optional(),
  name: z.string().min(1).nullable().optional(),
  about: z.string().min(1).nullable().optional(),
  imgUrl: z.string().min(1).nullable().optional(),
  isBusiness: z.boolean().nullable().optional(),
});

export type ExecutionStrategy = z.infer<typeof executionStrategySchema>;
export type ZApiProviderRegistryRow = z.infer<typeof zapiProviderRegistryRowSchema>;
export type ZApiStatusSnapshot = z.infer<typeof zapiStatusSnapshotSchema>;
export type ZApiDeviceSnapshot = z.infer<typeof zapiDeviceSnapshotSchema>;
export type ZApiMeSnapshot = z.infer<typeof zapiMeSnapshotSchema>;

export function parseZApiProviderRegistryRows(rows: unknown): ZApiProviderRegistryRow[] {
  const result = zapiProviderRegistryRowsSchema.safeParse(rows);

  if (!result.success) {
    const formatted = result.error.issues
      .map((error) => `  [${error.path.join(".")}] ${error.message}`)
      .join("\n");

    throw new Error(`Configuração Z-API inválida no banco:\n${formatted}`);
  }

  return result.data;
}
