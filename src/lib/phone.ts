import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normaliza um telefone para E.164 completo (`+5547997490248`).
 *
 * Aceita input com ou sem `+`. Se vier sem `+`, assume que os dígitos iniciais
 * são o country code (ex.: `"5547997490248"` → `"+5547997490248"`). Retorna
 * `null` para input vazio, inválido ou não parseável pelo libphonenumber-js.
 *
 * Fronteira de entrada no domínio: webhook, HTTP, scripts.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}

/**
 * Converte E.164 (`+5547997490248`) para o formato dígitos-puros exigido pela
 * Z-API (`5547997490248`). Null-safe.
 *
 * Uso restrito à fronteira de saída Z-API (`src/gateways/whatsapp/zapi/`).
 */
export function toZapiDigits(e164: string | null): string | null {
  if (e164 == null) return null;
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

/**
 * Extrai dígitos crus de um phone raw para uso como `wa_id` em lookups.
 * Retorna null se fora do range de dígitos esperado (8–15).
 *
 * Só para match — persistência sempre em E.164.
 */
export function rawWaIdCandidate(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/**
 * Deriva o `wa_id` canonical do WhatsApp (`<digits>@s.whatsapp.net`) a partir
 * de um phone E.164 (`+5547997490248`) ou Z-API digits (`5547997490248`).
 * Retorna null se o input não for parseável.
 */
export function toWaId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Aceita já no formato `<id>@s.whatsapp.net` (passa sem mudança).
  if (trimmed.endsWith("@s.whatsapp.net")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `${digits}@s.whatsapp.net`;
}
