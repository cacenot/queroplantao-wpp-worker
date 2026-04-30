import { ZApiError } from "../../gateways/whatsapp/zapi/client.ts";

export type OutboundMessageError = {
  message: string;
  name?: string;
  stack?: string;
  status?: number;
  body?: unknown;
};

/**
 * Normaliza um erro pra gravação em `outbound_messages.error`.
 *
 * Quando o erro é um `ZApiError`, preserva `status` (HTTP status code) e `body`
 * (resposta crua da Z-API) — campos críticos para diagnóstico de 4xx, já que a
 * Z-API tem N motivos de 400 distintos no body (`"Phone number doesn't exist"`,
 * `"You must to be on group to manager its members"`, etc.) e nenhum no `message`.
 *
 * Para wrappers (`NonRetryableError`), o `cause` nativo expõe o erro original —
 * o Sentry segue a chain automaticamente. Aqui, se o `cause` for `ZApiError`,
 * priorizamos os campos do erro original em vez do wrapper genérico.
 */
export function normalizeOutboundError(err: unknown): OutboundMessageError {
  const zapi = unwrapZApiError(err);
  if (zapi) {
    return {
      message: zapi.message,
      name: zapi.name,
      stack: zapi.stack,
      status: zapi.status,
      body: zapi.body,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

function unwrapZApiError(err: unknown): ZApiError | null {
  if (err instanceof ZApiError) return err;
  if (err instanceof Error && err.cause instanceof ZApiError) return err.cause;
  return null;
}
