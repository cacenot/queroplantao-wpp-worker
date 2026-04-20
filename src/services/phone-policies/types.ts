import type { PhonePolicyKind, PhonePolicySource } from "../../db/schema/phone-policies.ts";

export type { PhonePolicyKind, PhonePolicySource };

export type Protocol = "whatsapp" | "telegram";

/** Visão plana (datas ISO) exposta pelos services/API. */
export type PhonePolicyView = {
  id: string;
  protocol: Protocol;
  kind: PhonePolicyKind;
  phone: string;
  groupExternalId: string | null;
  source: PhonePolicySource;
  reason: string | null;
  notes: string | null;
  moderationId: string | null;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AddPhonePolicyInput = {
  protocol: Protocol;
  kind: PhonePolicyKind;
  phone: string;
  groupExternalId?: string | null;
  source?: PhonePolicySource;
  reason?: string | null;
  notes?: string | null;
  moderationId?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | string | null;
};

export type ListPhonePoliciesFilters = {
  protocol?: Protocol;
  kind?: PhonePolicyKind;
  phone?: string;
  groupExternalId?: string | null;
  source?: PhonePolicySource;
};

export type ListPhonePoliciesResult = {
  data: PhonePolicyView[];
  pagination: { limit: number; offset: number; total: number };
};

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
