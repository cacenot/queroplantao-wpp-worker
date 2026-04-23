import type { Logger } from "pino";
import type { ZApiClient } from "../../gateways/whatsapp/zapi/client.ts";
import { toE164 } from "../../lib/phone.ts";
import type { PhonePoliciesService } from "../../services/phone-policies/index.ts";
import { ConflictError } from "../../services/phone-policies/index.ts";

const BLACKLIST: string[] = [
  "5527997720494",
  "5511976329711",
  "5514982003231",
  "558195261118",
  "558394186568",
  "5514982298134",
  "5511951634176",
  "5521979666079",
  "557798982007",
  "5516998982703",
  "5515981748850",
  "553171837455",
];

type BypassEntry = { nome: string; telefone: string; funcao: string };

// Inclui ambos os formatos (13-dig e 12-dig) para a mesma pessoa. O seed processa
// 12-dig primeiro (sort por length) para garantir que waId seja persistido antes
// que a entrada 13-dig do mesmo número conflite e seja pulada.
const BYPASS: BypassEntry[] = [
  { nome: "Bianca Muniz", telefone: "5547991778115", funcao: "Gestão Médica" },
  { nome: "Aruana Cugnier", telefone: "5547990004074", funcao: "Gestão Médica" },
  { nome: "Rafael Mueller", telefone: "5547992854422", funcao: "Gestão Médica" },
  { nome: "Kariny Eustáquio", telefone: "5547991222326", funcao: "Gestão Médica" },
  { nome: "Andressa Santos", telefone: "5547988871024", funcao: "Captação Médica" },
  { nome: "Camilley Miranda", telefone: "5547992647983", funcao: "Captação Médica" },
  { nome: "Jenyffer Booz", telefone: "5547991545256", funcao: "Captação Médica" },
  { nome: "Paulo Henrique", telefone: "5547992653054", funcao: "Gerente Operacional" },
  { nome: "Pedro Mendonça", telefone: "5547991578232", funcao: "Gerente Comercial" },
  { nome: "Maria Helena", telefone: "5547991490017", funcao: "Financeiro" },
  { nome: "Giullia Martins", telefone: "5547998369871", funcao: "Recursos Humanos" },
  { nome: "Lucas Iomes", telefone: "5547988082244", funcao: "Diretor Comercial" },
  {
    nome: "Dra Ana Paula D'Artibale",
    telefone: "5547992022981",
    funcao: "Fundadora da Quero Plantão",
  },
  // Variante 12-dig (sem 9 após DDD 47) — mesmas pessoas acima
  { nome: "Bianca Muniz", telefone: "554791778115", funcao: "Gestão Médica" },
  { nome: "Aruana Cugnier", telefone: "554790004074", funcao: "Gestão Médica" },
  { nome: "Rafael Mueller", telefone: "554792854422", funcao: "Gestão Médica" },
  { nome: "Kariny Eustáquio", telefone: "554791222326", funcao: "Gestão Médica" },
  { nome: "Andressa Santos", telefone: "554788871024", funcao: "Captação Médica" },
  { nome: "Camilley Miranda", telefone: "554792647983", funcao: "Captação Médica" },
  { nome: "Jenyffer Booz", telefone: "554791545256", funcao: "Captação Médica" },
  { nome: "Paulo Henrique", telefone: "554792653054", funcao: "Gerente Operacional" },
  { nome: "Pedro Mendonça", telefone: "554791578232", funcao: "Gerente Comercial" },
  { nome: "Maria Helena", telefone: "554791490017", funcao: "Financeiro" },
  { nome: "Giullia Martins", telefone: "554798369871", funcao: "Recursos Humanos" },
  { nome: "Lucas Iomes", telefone: "554788082244", funcao: "Diretor Comercial" },
  {
    nome: "Dra Ana Paula D'Artibale",
    telefone: "554792022981",
    funcao: "Fundadora da Quero Plantão",
  },
  // Novos (com ambas as variantes)
  { nome: "NOVO", telefone: "5547992569031", funcao: "Gestão Médica" },
  { nome: "NOVO", telefone: "5547988030361", funcao: "Gestão Médica" },
  { nome: "NOVO", telefone: "5547989090644", funcao: "Gestão Médica" },
  { nome: "NOVO", telefone: "554792569031", funcao: "Gestão Médica" },
  { nome: "NOVO", telefone: "554788030361", funcao: "Gestão Médica" },
  { nome: "NOVO", telefone: "554789090644", funcao: "Gestão Médica" },
  // Sem variante 12-dig na lista
  { nome: "JOAO", telefone: "5521997085397", funcao: "IA" },
  // Somente variante 12-dig (sem 9 após DDD 47)
  { nome: "Fernando", telefone: "554797490248", funcao: "IA" },
  { nome: "Maisa", telefone: "554796348005", funcao: "Gestão Médica" },
  { nome: "Thiago MKT", telefone: "554792162285", funcao: "Marketing" },
  { nome: "Carol MKT", telefone: "554789180136", funcao: "Marketing" },
];

type ResolvedPhone = { phone: string; waId: string | null };

async function resolvePhone(raw: string, zapi: ZApiClient): Promise<ResolvedPhone | null> {
  const e164 = toE164(raw);

  if (e164) {
    const result = await zapi.phoneExists(e164);
    if (result.exists) return { phone: e164, waId: null };
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.startsWith("55") && digits.length === 13) {
    // BR 13-dig: tenta sem 9 após DDD (pré-2016)
    const without9 = `${digits.slice(0, 4)}${digits.slice(5)}`;
    const result = await zapi.phoneExists(without9);
    if (result.exists) {
      return { phone: e164 ?? `+${digits}`, waId: without9 };
    }
  } else if (digits.startsWith("55") && digits.length === 12) {
    // BR 12-dig: injeta 9 após DDD
    const with9 = `${digits.slice(0, 4)}9${digits.slice(4)}`;
    const e164With9 = toE164(with9);
    if (e164With9) {
      const result = await zapi.phoneExists(with9);
      if (result.exists) {
        return { phone: e164With9, waId: digits };
      }
    }
    // Último recurso: tenta o 12-dig diretamente
    const result12 = await zapi.phoneExists(digits);
    if (result12.exists) {
      const fallbackE164 = toE164(with9);
      return { phone: fallbackE164 ?? `+${with9}`, waId: digits };
    }
  }

  return null;
}

export type SeedPhonePoliciesResult = {
  created: number;
  skipped: number;
  notOnWhatsApp: number;
};

export async function seedPhonePolicies(
  service: PhonePoliciesService,
  zapi: ZApiClient,
  log: Logger
): Promise<SeedPhonePoliciesResult> {
  const result: SeedPhonePoliciesResult = { created: 0, skipped: 0, notOnWhatsApp: 0 };

  type Entry = { raw: string; kind: "blacklist" | "bypass"; notes: string };

  const entries: Entry[] = [
    ...BLACKLIST.map((raw) => ({ raw, kind: "blacklist" as const, notes: "" })),
    // 12-dig antes de 13-dig: garante que waId seja salvo antes do conflito
    ...[...BYPASS]
      .sort((a, b) => a.telefone.length - b.telefone.length)
      .map(({ telefone, nome, funcao }) => ({
        raw: telefone,
        kind: "bypass" as const,
        notes: `${nome} — ${funcao}`,
      })),
  ];

  for (const entry of entries) {
    const resolved = await resolvePhone(entry.raw, zapi);

    if (!resolved) {
      log.warn({ raw: entry.raw, kind: entry.kind }, "Número não encontrado no WhatsApp — pulando");
      result.notOnWhatsApp++;
      continue;
    }

    try {
      await service.add({
        protocol: "whatsapp",
        kind: entry.kind,
        phone: resolved.phone,
        waId: resolved.waId,
        source: "manual",
        notes: entry.notes || null,
      });
      result.created++;
    } catch (err) {
      if (err instanceof ConflictError) {
        result.skipped++;
        continue;
      }
      throw err;
    }
  }

  return result;
}
