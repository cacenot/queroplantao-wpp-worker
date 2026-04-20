import { and, asc, desc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  type NewPhonePolicyRow,
  type PhonePolicyKind,
  type PhonePolicyRow,
  type PhonePolicySource,
  phonePolicies,
} from "../schema/phone-policies.ts";
import type { messagingProtocolEnum } from "../schema/provider-registry.ts";

type Protocol = (typeof messagingProtocolEnum.enumValues)[number];

export type PhonePoliciesListFilters = {
  protocol?: Protocol;
  kind?: PhonePolicyKind;
  phone?: string;
  groupExternalId?: string | null;
  source?: PhonePolicySource;
};

export type PhonePoliciesPagination = {
  limit: number;
  offset: number;
};

export class PhonePoliciesRepository {
  constructor(private readonly db: Db) {}

  async create(row: NewPhonePolicyRow): Promise<PhonePolicyRow> {
    const [inserted] = await this.db.insert(phonePolicies).values(row).returning();
    if (!inserted) {
      throw new Error("Falha ao inserir phone_policies — nenhuma linha retornada");
    }
    return inserted;
  }

  async findById(id: string): Promise<PhonePolicyRow | null> {
    const [row] = await this.db
      .select()
      .from(phonePolicies)
      .where(eq(phonePolicies.id, id))
      .limit(1);
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(phonePolicies)
      .where(eq(phonePolicies.id, id))
      .returning({ id: phonePolicies.id });
    return deleted.length > 0;
  }

  /**
   * Retorna a política mais específica (group-scoped > global) para o trio
   * (protocol, kind, phone). Ignora entries expiradas.
   */
  async findMatch(
    protocol: Protocol,
    kind: PhonePolicyKind,
    phone: string,
    groupExternalId: string
  ): Promise<PhonePolicyRow | null> {
    const [row] = await this.db
      .select()
      .from(phonePolicies)
      .where(
        and(
          eq(phonePolicies.protocol, protocol),
          eq(phonePolicies.kind, kind),
          eq(phonePolicies.phone, phone),
          or(
            eq(phonePolicies.groupExternalId, groupExternalId),
            isNull(phonePolicies.groupExternalId)
          ),
          or(isNull(phonePolicies.expiresAt), gt(phonePolicies.expiresAt, new Date()))
        )
      )
      .orderBy(sql`${phonePolicies.groupExternalId} NULLS LAST`)
      .limit(1);
    return row ?? null;
  }

  async list(
    filters: PhonePoliciesListFilters,
    pagination: PhonePoliciesPagination
  ): Promise<{ rows: PhonePolicyRow[]; total: number }> {
    const conditions = this.buildConditions(filters);

    const rows = await this.db
      .select()
      .from(phonePolicies)
      .where(conditions)
      .orderBy(desc(phonePolicies.createdAt), asc(phonePolicies.phone))
      .limit(pagination.limit)
      .offset(pagination.offset);

    const [totalRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(phonePolicies)
      .where(conditions);

    return { rows, total: totalRow?.count ?? 0 };
  }

  private buildConditions(filters: PhonePoliciesListFilters): SQL | undefined {
    const parts: SQL[] = [];
    if (filters.protocol) parts.push(eq(phonePolicies.protocol, filters.protocol));
    if (filters.kind) parts.push(eq(phonePolicies.kind, filters.kind));
    if (filters.phone) parts.push(eq(phonePolicies.phone, filters.phone));
    if (filters.source) parts.push(eq(phonePolicies.source, filters.source));
    if (filters.groupExternalId === null) {
      parts.push(isNull(phonePolicies.groupExternalId));
    } else if (typeof filters.groupExternalId === "string") {
      parts.push(eq(phonePolicies.groupExternalId, filters.groupExternalId));
    }
    return parts.length > 0 ? and(...parts) : undefined;
  }
}
