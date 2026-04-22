/**
 * Fonte única de verdade das categorias de moderação.
 *
 * Usada pelo schema Zod (`moderator.ts`) e pelo TypeBox do endpoint HTTP
 * (`api/modules/moderation-config/model.ts`) — evita drift entre validações
 * de runtime que olham o mesmo dado por caminhos diferentes.
 */
export const CATEGORIES = ["clean", "job_opportunity", "sales", "spam", "scam"] as const;

export type Category = (typeof CATEGORIES)[number];
