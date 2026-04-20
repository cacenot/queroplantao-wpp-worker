import type {
  PhonePoliciesPagination,
  PhonePoliciesRepository,
} from "../../db/repositories/phone-policies-repository.ts";
import type { NewPhonePolicyRow } from "../../db/schema/phone-policies.ts";
import { normalizePhone, toPhonePolicyView } from "./serialize.ts";
import {
  type AddPhonePolicyInput,
  ConflictError,
  type ListPhonePoliciesFilters,
  type ListPhonePoliciesResult,
  NotFoundError,
  type PhonePolicyView,
  type Protocol,
  ValidationError,
} from "./types.ts";

type PhonePoliciesServiceDeps = {
  repo: PhonePoliciesRepository;
};

export class PhonePoliciesService {
  constructor(private readonly deps: PhonePoliciesServiceDeps) {}

  async add(input: AddPhonePolicyInput): Promise<PhonePolicyView> {
    const phone = normalizePhone(input.phone);
    if (phone.length < 8 || phone.length > 15) {
      throw new ValidationError(
        `Phone inválido após normalização (esperado 8-15 dígitos, obtido ${phone.length})`
      );
    }

    const row: NewPhonePolicyRow = {
      protocol: input.protocol,
      kind: input.kind,
      phone,
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
        throw new ConflictError(
          `Política já existe para (${row.protocol}, ${row.kind}, ${row.phone}, ${row.groupExternalId ?? "global"})`
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
        phone: filters.phone ? normalizePhone(filters.phone) : undefined,
      },
      pagination
    );
    return {
      data: rows.map(toPhonePolicyView),
      pagination: { limit: pagination.limit, offset: pagination.offset, total },
    };
  }

  async isBlacklisted(
    phone: string,
    protocol: Protocol,
    groupExternalId: string
  ): Promise<PhonePolicyView | null> {
    return this.findMatch(protocol, "blacklist", phone, groupExternalId);
  }

  async isBypassed(
    phone: string,
    protocol: Protocol,
    groupExternalId: string
  ): Promise<PhonePolicyView | null> {
    return this.findMatch(protocol, "bypass", phone, groupExternalId);
  }

  private async findMatch(
    protocol: Protocol,
    kind: "blacklist" | "bypass",
    phone: string,
    groupExternalId: string
  ): Promise<PhonePolicyView | null> {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;
    const row = await this.deps.repo.findMatch(protocol, kind, normalized, groupExternalId);
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

// Nome vem da migration 0008_smiling_flatman.sql (index `phone_policies_unique_idx`).
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /phone_policies_unique_idx|duplicate key/i.test(err.message);
}
