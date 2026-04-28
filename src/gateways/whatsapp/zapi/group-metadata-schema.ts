import { z } from "zod";

// Resposta de GET /group-metadata-light/{groupId}
// Docs: https://developer.z-api.io/group/light-group-metadata
//
// Apenas os campos que consumimos são validados; demais ficam tolerados via
// `.passthrough()` para evitar quebra se a Z-API adicionar atributos novos.
//
// Em alguns grupos `phone` pode vir como dígitos puros (`5547...`) ou como LID
// (`<id>@lid` em comunidades novas) — o normalizer separa os dois casos.
export const zapiGroupMetadataLightParticipantSchema = z
  .object({
    phone: z.string().min(1),
    isAdmin: z.boolean().optional().default(false),
    isSuperAdmin: z.boolean().optional().default(false),
  })
  .passthrough();

export const zapiGroupMetadataLightSchema = z
  .object({
    phone: z.string().optional(),
    description: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    creation: z.number().int().nullable().optional(),
    participants: z.array(zapiGroupMetadataLightParticipantSchema),
  })
  .passthrough();

export type ZApiGroupMetadataLightParticipant = z.infer<
  typeof zapiGroupMetadataLightParticipantSchema
>;
export type ZApiGroupMetadataLight = z.infer<typeof zapiGroupMetadataLightSchema>;
