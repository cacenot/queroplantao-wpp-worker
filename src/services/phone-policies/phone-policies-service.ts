import type {
  PhonePoliciesPagination,
  PhonePoliciesRepository,
} from "../../db/repositories/phone-policies-repository.ts";
import type { NewPhonePolicyRow } from "../../db/schema/phone-policies.ts";
import { toE164 } from "../../lib/phone.ts";
import { toPhonePolicyView } from "./serialize.ts";
import {
  type AddPhonePolicyInput,
  ConflictError,
  type ListPhonePoliciesFilters,
  type ListPhonePoliciesResult,
  NotFoundError,
  type PhonePolicyMatchInput,
  type PhonePolicyView,
  ValidationError,
} from "./types.ts";

type PhonePoliciesServiceDeps = {
  repo: PhonePoliciesRepository;
};

export class PhonePoliciesService {
  constructor(private readonly deps: PhonePoliciesServiceDeps) {}

  async add(input: AddPhonePolicyInput): Promise<PhonePolicyView> {
    const rawPhone = input.phone?.trim();
    const phone = toE164(rawPhone);
    if (rawPhone && phone === null) {
      throw new ValidationError(`Phone inválido (esperado E.164, obtido "${rawPhone}")`);
    }

    const senderExternalId = input.senderExternalId?.trim() || null;

    if (!phone && !senderExternalId) {
      throw new ValidationError("Pelo menos um de `phone` ou `senderExternalId` é obrigatório");
    }

    const row: NewPhonePolicyRow = {
      protocol: input.protocol,
      kind: input.kind,
      phone,
      senderExternalId,
      groupExternalId: input.groupExternalId ?? null,
      source: input.source ?? "manual",
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      moderationId: input.moderationId ?? null,
      metadata: input.metadata ?? {},
      expiresAt: toDate(input.expiresAt),
    };

    try {
      const created = await this.deps.repo.create(row);
      return toPhonePolicyView(created);
    } catch (err) {
      if (isUniqueViolation(err)) {
        const ident = phone ?? senderExternalId;
        throw new ConflictError(
          `Política já existe para (${row.protocol}, ${row.kind}, ${ident}, ${row.groupExternalId ?? "global"})`
        );
      }
      throw err;
    }
  }

  async get(id: string): Promise<PhonePolicyView | null> {
    const row = await this.deps.repo.findById(id);
    return row ? toPhonePolicyView(row) : null;
  }

  async remove(id: string): Promise<void> {
    const ok = await this.deps.repo.delete(id);
    if (!ok) {
      throw new NotFoundError(`Política ${id} não encontrada`);
    }
  }

  async list(
    filters: ListPhonePoliciesFilters,
    pagination: PhonePoliciesPagination
  ): Promise<ListPhonePoliciesResult> {
    const { rows, total } = await this.deps.repo.list(
      {
        ...filters,
        phone: filters.phone ? (toE164(filters.phone) ?? undefined) : undefined,
      },
      pagination
    );
    return {
      data: rows.map(toPhonePolicyView),
      pagination: { limit: pagination.limit, offset: pagination.offset, total },
    };
  }

  async isBlacklisted(input: PhonePolicyMatchInput): Promise<PhonePolicyView | null> {
    return this.findMatch("blacklist", input);
  }

  async isBypassed(input: PhonePolicyMatchInput): Promise<PhonePolicyView | null> {
    return this.findMatch("bypass", input);
  }

  private async findMatch(
    kind: "blacklist" | "bypass",
    input: PhonePolicyMatchInput
  ): Promise<PhonePolicyView | null> {
    const phone = toE164(input.phone);
    const senderExternalId = input.senderExternalId?.trim() || null;
    if (!phone && !senderExternalId) return null;

    const row = await this.deps.repo.findMatch(
      input.protocol,
      kind,
      { phone, senderExternalId },
      input.groupExternalId
    );
    return row ? toPhonePolicyView(row) : null;
  }
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`expiresAt inválido: ${value}`);
  }
  return parsed;
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /phone_policies_unique_(phone|external_id)_idx|duplicate key/i.test(err.message);
}
