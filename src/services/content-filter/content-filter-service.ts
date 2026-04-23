import { toZapiDigits } from "../../lib/phone.ts";
import { SUSPICIOUS_CONTENT, SUSPICIOUS_DDI_PREFIXES, SUSPICIOUS_NAMES } from "./rules.ts";

export type ContentFilterInput = {
  senderPhone: string | null;
  senderName: string | null;
  normalizedText: string | null;
  caption: string | null;
};

export type ContentFilterHit = {
  motivo: "ddi" | "nome_bot" | "nome" | "content";
  match: string;
};

export class ContentFilterService {
  detect(input: ContentFilterInput): ContentFilterHit | null {
    const digits = toZapiDigits(input.senderPhone);
    const name = input.senderName ?? "";
    const text = input.normalizedText ?? "";
    const caption = input.caption ?? "";

    // 1. DDI suspeito — só pra números não-BR
    if (digits && !digits.startsWith("55")) {
      const ddi = digits.slice(0, 2);
      if ((SUSPICIOUS_DDI_PREFIXES as readonly string[]).includes(ddi)) {
        return { motivo: "ddi", match: ddi };
      }
    }

    // 2. Padrão de bot: name == "MI" + últimos 6 dígitos do phone
    if (digits && name === `MI${digits.slice(-6)}`) {
      return { motivo: "nome_bot", match: name };
    }

    // 3. Substring em nome
    for (const n of SUSPICIOUS_NAMES) {
      if (name.includes(n)) return { motivo: "nome", match: n };
    }

    // 4. Substring em texto OU caption (unificado)
    const haystack = `${text}\n${caption}`;
    for (const p of SUSPICIOUS_CONTENT) {
      if (haystack.includes(p)) return { motivo: "content", match: p };
    }

    return null;
  }
}
