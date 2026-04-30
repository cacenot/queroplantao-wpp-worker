import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { messagingGroups } from "./messaging-groups.ts";
import {
  messagingProtocolEnum,
  messagingProviderInstances,
  messagingProviderKindEnum,
} from "./provider-registry.ts";
import { tasks } from "./tasks.ts";

export const outboundMessageStatusEnum = pgEnum("outbound_message_status", [
  "pending",
  "queued",
  "sending",
  "sent",
  "failed",
  "dropped",
]);

export const outboundMessageTargetKindEnum = pgEnum("outbound_message_target_kind", [
  "group",
  "contact",
]);

export const outboundMessageContentKindEnum = pgEnum("outbound_message_content_kind", [
  "text",
  "image",
  "video",
  "link",
  "location",
  "buttons",
]);

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    providerKind: messagingProviderKindEnum("provider_kind").notNull(),
    providerInstanceId: uuid("provider_instance_id").references(
      () => messagingProviderInstances.id,
      { onDelete: "set null" }
    ),
    targetKind: outboundMessageTargetKindEnum("target_kind").notNull(),
    // groupId em group; phone E.164 em contact. Indexado em (target_external_id, created_at)
    // — queries "histórico por destino" filtram aqui (e por target_kind quando precisam
    // distinguir grupo de contato).
    targetExternalId: text("target_external_id").notNull(),
    messagingGroupId: uuid("messaging_group_id").references(() => messagingGroups.id, {
      onDelete: "set null",
    }),
    contentKind: outboundMessageContentKindEnum("content_kind").notNull(),
    // Payload completo do envio (mensagem, urls, coords, botões).
    content: jsonb("content").$type<unknown>().notNull(),
    externalMessageId: text("external_message_id"),
    status: outboundMessageStatusEnum("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    // `status` e `body` carregam contexto rico quando o erro vem do `ZApiError`
    // (resposta HTTP da Z-API). Para outros erros, ficam undefined.
    error: jsonb("error").$type<{
      message: string;
      name?: string;
      stack?: string;
      status?: number;
      body?: unknown;
    } | null>(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    // Reservado para bulk send (ainda sem tabela de batches; sem FK).
    batchId: uuid("batch_id"),
    // Reservado para schedule (NULL = imediato).
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    requestedBy: text("requested_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => ({
    statusCreatedIdx: index("outbound_messages_status_created_at_idx").on(
      table.status,
      table.createdAt
    ),
    providerInstanceIdx: index("outbound_messages_provider_instance_idx").on(
      table.providerInstanceId,
      table.createdAt
    ),
    targetIdx: index("outbound_messages_target_idx").on(table.targetExternalId, table.createdAt),
    contentKindIdx: index("outbound_messages_content_kind_idx").on(
      table.contentKind,
      table.createdAt
    ),
    // Partial unique — caller pode passar a mesma chave duas vezes só sem ela.
    idempotencyKeyIdx: uniqueIndex("outbound_messages_idempotency_key_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    batchStatusIdx: index("outbound_messages_batch_status_idx").on(table.batchId, table.status),
  })
);

export const outboundMessagesRelations = relations(outboundMessages, ({ one }) => ({
  providerInstance: one(messagingProviderInstances, {
    fields: [outboundMessages.providerInstanceId],
    references: [messagingProviderInstances.id],
  }),
  messagingGroup: one(messagingGroups, {
    fields: [outboundMessages.messagingGroupId],
    references: [messagingGroups.id],
  }),
  task: one(tasks, {
    fields: [outboundMessages.taskId],
    references: [tasks.id],
  }),
}));

export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type NewOutboundMessage = typeof outboundMessages.$inferInsert;
