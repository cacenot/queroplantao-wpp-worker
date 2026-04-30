/**
 * Lançar este erro em uma action indica que a falha é permanente e não deve
 * passar pelo ciclo de retry — o job vai direto para o DLQ.
 *
 * `cause` é passado pro `super(message, { cause })` nativo do `Error` (ES2022) —
 * o Sentry SDK detecta automaticamente e gera "exception chain", expondo o erro
 * original (ex.: `ZApiError`) no dashboard sem precisar abrir o blob.
 */
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
