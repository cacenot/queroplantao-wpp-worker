import type { Protocol } from "../phone-policies/index.ts";

export type { Protocol };

export type RemovalOptions = {
  allDays?: boolean;
  limit?: number;
};

export type AllowlistMatch = {
  policyId: string;
  phone: string | null;
  senderExternalId: string | null;
  groupExternalId: string | null;
  reason: string | null;
};

type RemovalCounts = {
  messageCount: number;
  groupCount: number;
  senderCount: number;
  /** Mensagens ignoradas por sender/grupo estar na allowlist (bypass). */
  excludedByAllowlistCount: number;
};

export type RemovalPreviewByPhone = {
  mode: "by-phone";
  /** Se o phone está em allowlist → abortar antes de executar. */
  allowlistConflict: AllowlistMatch | null;
  /** A blacklist global já existe pra esse phone. */
  blacklistedAlready: boolean;
} & RemovalCounts;

export type RemovalPreviewBySpam = { mode: "by-spam" } & RemovalCounts;

export type RemovalPreview = RemovalPreviewByPhone | RemovalPreviewBySpam;

type RemovalEnqueue = {
  messagesDeleteEnqueued: number;
  participantsRemoveEnqueued: number;
  excludedByAllowlistCount: number;
};

export type RemovalResultByPhone = {
  mode: "by-phone";
  /** Inseriu linha nova na blacklist nesta execução. */
  blacklistAdded: boolean;
  /** Já existia blacklist global para esse phone. */
  alreadyBlacklisted: boolean;
} & RemovalEnqueue;

export type RemovalResultBySpam = { mode: "by-spam" } & RemovalEnqueue;

export type RemovalResult = RemovalResultByPhone | RemovalResultBySpam;

export type ByPhoneInput = {
  /** Input bruto — validado e normalizado internamente (toE164 + dígitos). */
  phone: string;
  protocol?: Protocol;
  options?: RemovalOptions;
};

export type BySpamInput = {
  filters: string[];
  protocol?: Protocol;
  options?: RemovalOptions;
};

export class PhoneFilterTooShortError extends Error {
  constructor(public readonly minDigits: number) {
    super(`Phone precisa ter no mínimo ${minDigits} dígitos`);
    this.name = "PhoneFilterTooShortError";
  }
}

export class InvalidPhoneError extends Error {
  constructor(raw: string) {
    super(`Phone inválido (não parseável como E.164): "${raw}"`);
    this.name = "InvalidPhoneError";
  }
}

export class AllowlistConflictError extends Error {
  constructor(public readonly match: AllowlistMatch) {
    super(
      `Phone está em allowlist (policy ${match.policyId}) — remova da allowlist antes de executar`
    );
    this.name = "AllowlistConflictError";
  }
}

export class NoFiltersError extends Error {
  constructor() {
    super("Pelo menos um filtro é obrigatório");
    this.name = "NoFiltersError";
  }
}
