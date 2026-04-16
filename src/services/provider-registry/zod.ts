import { z } from "zod";

export const executionStrategySchema = z.enum(["leased", "passthrough"]);

export const zapiProviderRegistryRowSchema = z.object({
  providerId: z.string().uuid(),
  displayName: z.string().min(1),
  executionStrategy: executionStrategySchema,
  redisKey: z.string().min(1).nullable(),
  cooldownMinMs: z.number().int().nonnegative().nullable(),
  cooldownMaxMs: z.number().int().nonnegative().nullable(),
  safetyTtlMs: z.number().int().positive().nullable(),
  heartbeatIntervalMs: z.number().int().positive().nullable(),
  instanceId: z.string().min(1),
  instanceToken: z.string().min(1),
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

export type ExecutionStrategy = z.infer<typeof executionStrategySchema>;
export type ZApiProviderRegistryRow = z.infer<typeof zapiProviderRegistryRowSchema>;
export type ZApiStatusSnapshot = z.infer<typeof zapiStatusSnapshotSchema>;
export type ZApiDeviceSnapshot = z.infer<typeof zapiDeviceSnapshotSchema>;

export function parseZApiProviderRegistryRows(rows: unknown): ZApiProviderRegistryRow[] {
  const result = zapiProviderRegistryRowsSchema.safeParse(rows);

  if (!result.success) {
    const formatted = result.error.errors
      .map((error) => `  [${error.path.join(".")}] ${error.message}`)
      .join("\n");

    throw new Error(`Configuração Z-API inválida no banco:\n${formatted}`);
  }

  return result.data;
}
