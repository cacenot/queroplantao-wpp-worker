import { z } from "zod";

// Resposta de GET /group-metadata/{groupId}
// Docs: https://developer.z-api.io/group/metadata-group
//
// Apenas os campos que consumimos são validados; demais ficam tolerados via
// `.passthrough()` para evitar quebra se a Z-API adicionar atributos novos.
//
// Em alguns grupos `phone` pode vir como dígitos puros (`5547...`) ou como LID
// (`<id>@lid` em comunidades novas) — o normalizer separa os dois casos.
export const zapiGroupMetadataParticipantSchema = z
  .object({
    phone: z.string().min(1),
    isAdmin: z.boolean().optional().default(false),
    isSuperAdmin: z.boolean().optional().default(false),
  })
  .passthrough();

export const zapiGroupMetadataSchema = z
  .object({
    phone: z.string().optional(),
    description: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    creation: z.number().int().nullable().optional(),
    participants: z.array(zapiGroupMetadataParticipantSchema),
  })
  .passthrough();

export type ZApiGroupMetadataParticipant = z.infer<typeof zapiGroupMetadataParticipantSchema>;
export type ZApiGroupMetadata = z.infer<typeof zapiGroupMetadataSchema>;
