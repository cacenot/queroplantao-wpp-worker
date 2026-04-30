import type { Logger } from "pino";

/**
 * Loga warn e silencia o erro — para chamadas best-effort (transições de status,
 * métricas, side effects que não devem abortar o fluxo principal).
 *
 * Uso:
 *   await taskService.markSucceeded(id).catch(warnOnFail(log, "Falha ao marcar succeeded"));
 *
 * Se o erro genuinamente não importa, prefira `.catch(() => {})` com comentário
 * explícito; o `warnOnFail` é o caminho default quando você quer rastreabilidade
 * do erro mas não pode propagar.
 */
export function warnOnFail(log: Logger, message: string) {
  return (err: unknown) => log.warn({ err }, message);
}
