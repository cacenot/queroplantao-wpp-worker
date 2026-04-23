import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../../db/client.ts";
import type { JobSchema } from "../../jobs/schemas.ts";
import { toE164 } from "../../lib/phone.ts";
import {
  type PhonePoliciesService,
  ConflictError as PhonePolicyConflictError,
  type Protocol,
} from "../phone-policies/index.ts";
import type { TaskService } from "../task/index.ts";
import {
  AllowlistConflictError,
  type AllowlistMatch,
  type ByPhoneInput,
  type BySpamInput,
  InvalidPhoneError,
  NoFiltersError,
  PhoneFilterTooShortError,
  type RemovalOptions,
  type RemovalPreviewByPhone,
  type RemovalPreviewBySpam,
  type RemovalResultByPhone,
  type RemovalResultBySpam,
} from "./types.ts";

const MIN_PHONE_DIGITS = 10;
const DEFAULT_PROTOCOL: Protocol = "whatsapp";
const MODEL_BY_PHONE = "manual:remove-by-phone";
const MODEL_BY_SPAM = "manual:remove-spam";
// Versão fixa por tipo de remoção manual — a UNIQUE (group_message_id, moderation_version)
// impede que a mesma msg receba múltiplas linhas manuais de moderação.
const MODERATION_VERSION = "manual-v1";

type Deps = {
  db: Db;
  phonePoliciesService: PhonePoliciesService;
  taskService: TaskService;
  logger?: Logger;
};

type RawRow = {
  group_message_id: string;
  external_message_id: string;
  group_external_id: string;
  sender_phone: string | null;
  sender_external_id: string | null;
  content_hash: string;
  provider_instance_id: string;
  protocol: Protocol;
  allowlist_policy_id: string | null;
};

type ParsedByPhone = {
  e164: string;
  digitsForFilter: string;
  protocol: Protocol;
  options: RemovalOptions;
};

type ParsedBySpam = {
  filters: string[];
  protocol: Protocol;
  options: RemovalOptions;
};

export class GroupMessagesRemovalService {
  private readonly db: Db;
  private readonly phonePoliciesService: PhonePoliciesService;
  private readonly taskService: TaskService;
  private readonly logger?: Logger;

  constructor(deps: Deps) {
    this.db = deps.db;
    this.phonePoliciesService = deps.phonePoliciesService;
    this.taskService = deps.taskService;
    this.logger = deps.logger;
  }

  async previewByPhone(input: ByPhoneInput): Promise<RemovalPreviewByPhone> {
    const parsed = this.parseByPhoneInput(input);
    const allowlist = await this.findAllowlistForPhone(parsed.protocol, parsed.e164);
    if (allowlist) {
      return {
        mode: "by-phone",
        ...emptyCounts(),
        allowlistConflict: allowlist,
        blacklistedAlready: false,
      };
    }
    const blacklistedAlready = await this.isBlacklistedGlobally(parsed.protocol, parsed.e164);
    const rows = await this.fetchByPhoneRows(parsed);
    return {
      mode: "by-phone",
      ...buildCounts(rows),
      allowlistConflict: null,
      blacklistedAlready,
    };
  }

  async executeByPhone(input: ByPhoneInput): Promise<RemovalResultByPhone> {
    const parsed = this.parseByPhoneInput(input);
    const allowlist = await this.findAllowlistForPhone(parsed.protocol, parsed.e164);
    if (allowlist) throw new AllowlistConflictError(allowlist);

    const { blacklistAdded, alreadyBlacklisted } = await this.ensureBlacklisted(
      parsed.protocol,
      parsed.e164
    );
    const rows = await this.fetchByPhoneRows(parsed);
    const usable = rows.filter((r) => r.allowlist_policy_id === null);
    const published = await this.publishRemovalJobs(
      usable,
      MODEL_BY_PHONE,
      `phone match: ${parsed.e164}`
    );
    return {
      mode: "by-phone",
      ...published,
      blacklistAdded,
      alreadyBlacklisted,
      excludedByAllowlistCount: rows.length - usable.length,
    };
  }

  async previewBySpam(input: BySpamInput): Promise<RemovalPreviewBySpam> {
    const parsed = this.parseBySpamInput(input);
    const rows = await this.fetchBySpamRows(parsed);
    return { mode: "by-spam", ...buildCounts(rows) };
  }

  async executeBySpam(input: BySpamInput): Promise<RemovalResultBySpam> {
    const parsed = this.parseBySpamInput(input);
    const rows = await this.fetchBySpamRows(parsed);
    const usable = rows.filter((r) => r.allowlist_policy_id === null);
    const published = await this.publishRemovalJobs(
      usable,
      MODEL_BY_SPAM,
      `filters: ${parsed.filters.join(", ")}`
    );
    return {
      mode: "by-spam",
      ...published,
      excludedByAllowlistCount: rows.length - usable.length,
    };
  }

  // ─── Parsing ───────────────────────────────────────────────────────────────

  private parseByPhoneInput(input: ByPhoneInput): ParsedByPhone {
    const digitsForFilter = input.phone.replace(/\D/g, "");
    if (digitsForFilter.length < MIN_PHONE_DIGITS) {
      throw new PhoneFilterTooShortError(MIN_PHONE_DIGITS);
    }
    const e164 = toE164(input.phone);
    if (!e164) throw new InvalidPhoneError(input.phone);
    return {
      e164,
      digitsForFilter,
      protocol: input.protocol ?? DEFAULT_PROTOCOL,
      options: input.options ?? {},
    };
  }

  private parseBySpamInput(input: BySpamInput): ParsedBySpam {
    if (input.filters.length === 0) throw new NoFiltersError();
    return {
      filters: input.filters,
      protocol: input.protocol ?? DEFAULT_PROTOCOL,
      options: input.options ?? {},
    };
  }

  // ─── Policy lookups ────────────────────────────────────────────────────────

  private async findAllowlistForPhone(
    protocol: Protocol,
    e164: string
  ): Promise<AllowlistMatch | null> {
    const result = await this.db.execute<{
      id: string;
      phone: string | null;
      sender_external_id: string | null;
      group_external_id: string | null;
      reason: string | null;
    }>(sql`
      SELECT id, phone, sender_external_id, group_external_id, reason
      FROM phone_policies
      WHERE protocol = ${protocol}
        AND kind = 'bypass'
        AND phone = ${e164}
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `);
    const row = result[0];
    if (!row) return null;
    return {
      policyId: row.id,
      phone: row.phone,
      senderExternalId: row.sender_external_id,
      groupExternalId: row.group_external_id,
      reason: row.reason,
    };
  }

  private async isBlacklistedGlobally(protocol: Protocol, e164: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id
      FROM phone_policies
      WHERE protocol = ${protocol}
        AND kind = 'blacklist'
        AND phone = ${e164}
        AND group_external_id IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `);
    return result.length > 0;
  }

  private async ensureBlacklisted(
    protocol: Protocol,
    e164: string
  ): Promise<{ blacklistAdded: boolean; alreadyBlacklisted: boolean }> {
    try {
      await this.phonePoliciesService.add({
        protocol,
        kind: "blacklist",
        phone: e164,
        groupExternalId: null,
        source: "manual",
        reason: "manual via group-messages-removal-service",
      });
      return { blacklistAdded: true, alreadyBlacklisted: false };
    } catch (err) {
      if (err instanceof PhonePolicyConflictError) {
        return { blacklistAdded: false, alreadyBlacklisted: true };
      }
      throw err;
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  private async fetchByPhoneRows(parsed: ParsedByPhone): Promise<RawRow[]> {
    const filterPattern = `%${parsed.digitsForFilter}%`;
    return this.fetchRemovalRows(
      parsed.protocol,
      parsed.options,
      sql`
      gm.sender_phone ILIKE ${filterPattern}
    `
    );
  }

  private async fetchBySpamRows(parsed: ParsedBySpam): Promise<RawRow[]> {
    const ilikeClauses = parsed.filters
      .map((f) => sql`gm.normalized_text ILIKE ${`%${f}%`}`)
      .reduce((acc, cond) => sql`${acc} OR ${cond}`);
    return this.fetchRemovalRows(parsed.protocol, parsed.options, sql`(${ilikeClauses})`);
  }

  // SELECT + LATERAL JOIN com allowlist é comum entre by-phone e by-spam; o
  // único diferencial é o predicado (sender_phone ILIKE vs normalized_text ILIKE ANY).
  private async fetchRemovalRows(
    protocol: Protocol,
    options: RemovalOptions,
    extraPredicate: SQL
  ): Promise<RawRow[]> {
    const dateClause = this.dateClause(options.allDays);
    const limitClause = this.limitClause(options.limit);
    const rows = await this.db.execute<RawRow>(sql`
      SELECT
        gm.id AS group_message_id,
        gm.external_message_id,
        gm.group_external_id,
        gm.sender_phone,
        gm.sender_external_id,
        gm.content_hash,
        gm.provider_instance_id,
        gm.protocol,
        pp.id AS allowlist_policy_id
      FROM group_messages gm
      LEFT JOIN LATERAL (
        SELECT pp.id
        FROM phone_policies pp
        WHERE pp.protocol = gm.protocol
          AND pp.kind = 'bypass'
          AND (
            (pp.phone IS NOT NULL AND pp.phone = gm.sender_phone) OR
            (pp.sender_external_id IS NOT NULL AND pp.sender_external_id = gm.sender_external_id)
          )
          AND (pp.group_external_id IS NULL OR pp.group_external_id = gm.group_external_id)
          AND (pp.expires_at IS NULL OR pp.expires_at > now())
        LIMIT 1
      ) pp ON true
      WHERE gm.removed_at IS NULL
        AND gm.provider_instance_id IS NOT NULL
        AND gm.protocol = ${protocol}
        AND ${extraPredicate}
        ${dateClause}
      ORDER BY gm.sent_at DESC
      ${limitClause}
    `);
    return [...rows];
  }

  private dateClause(allDays?: boolean) {
    return allDays
      ? sql``
      : sql`AND gm.sent_at >= CURRENT_DATE AND gm.sent_at < CURRENT_DATE + INTERVAL '1 day'`;
  }

  private limitClause(limit?: number) {
    return limit && limit > 0 ? sql`LIMIT ${limit}` : sql``;
  }

  // ─── Publish ──────────────────────────────────────────────────────────────

  private async publishRemovalJobs(
    rows: RawRow[],
    model: string,
    reason: string
  ): Promise<{ messagesDeleteEnqueued: number; participantsRemoveEnqueued: number }> {
    if (rows.length === 0) {
      return { messagesDeleteEnqueued: 0, participantsRemoveEnqueued: 0 };
    }

    // — Registra moderation manual por msg (idempotente pelo unique index).
    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.db.execute(sql`
            INSERT INTO message_moderations (
              group_message_id, content_hash, moderation_version, model, source,
              status, action, category, reason, completed_at
            ) VALUES (
              ${row.group_message_id}, ${row.content_hash}, ${MODERATION_VERSION},
              ${model}, 'manual', 'analyzed', 'delete', 'manual', ${reason}, now()
            )
            ON CONFLICT (group_message_id, moderation_version) DO NOTHING
          `);
        } catch (err) {
          this.logger?.warn(
            { err, groupMessageId: row.group_message_id },
            "Falha ao inserir message_moderations manual — prosseguindo"
          );
        }
      })
    );

    const createdAt = new Date().toISOString();
    const removeDedup = new Set<string>();
    const jobs: JobSchema[] = [];

    for (const row of rows) {
      jobs.push({
        id: randomUUID(),
        type: "whatsapp.delete_message",
        payload: {
          providerInstanceId: row.provider_instance_id,
          messageId: row.external_message_id,
          phone: row.group_external_id,
          owner: false,
        },
        createdAt,
      });

      if (!row.sender_phone) continue;
      const dedupKey = `${row.provider_instance_id}:${row.group_external_id}:${row.sender_phone}`;
      if (removeDedup.has(dedupKey)) continue;
      removeDedup.add(dedupKey);
      jobs.push({
        id: randomUUID(),
        type: "whatsapp.remove_participant",
        payload: {
          providerInstanceId: row.provider_instance_id,
          groupId: row.group_external_id,
          phones: [row.sender_phone],
        },
        createdAt,
      });
    }

    await this.taskService.enqueue(jobs);

    return {
      messagesDeleteEnqueued: jobs.filter((j) => j.type === "whatsapp.delete_message").length,
      participantsRemoveEnqueued: jobs.filter((j) => j.type === "whatsapp.remove_participant")
        .length,
    };
  }
}

function emptyCounts() {
  return { messageCount: 0, groupCount: 0, senderCount: 0, excludedByAllowlistCount: 0 };
}

function buildCounts(rows: RawRow[]) {
  const usable = rows.filter((r) => r.allowlist_policy_id === null);
  const groups = new Set(usable.map((r) => r.group_external_id));
  const senders = new Set(
    usable.map((r) => r.sender_phone ?? r.sender_external_id).filter((s): s is string => s !== null)
  );
  return {
    messageCount: usable.length,
    groupCount: groups.size,
    senderCount: senders.size,
    excludedByAllowlistCount: rows.length - usable.length,
  };
}
