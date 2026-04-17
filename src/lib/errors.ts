/**
 * Lançar este erro em uma action indica que a falha é permanente e não deve
 * passar pelo ciclo de retry — o job vai direto para o DLQ.
 */
export class NonRetryableError extends Error {
  override readonly name = "NonRetryableError";

  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
  }
}
