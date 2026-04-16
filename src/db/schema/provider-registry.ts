import { relations } from "drizzle-orm";
import {
  boolean,
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

export const messagingProtocolEnum = pgEnum("messaging_protocol", ["whatsapp", "telegram"]);

export const messagingProviderKindEnum = pgEnum("messaging_provider_kind", [
  "whatsapp_zapi",
  "whatsapp_whatsmeow",
  "whatsapp_business_api",
  "telegram_bot",
]);

export const executionStrategyEnum = pgEnum("messaging_execution_strategy", [
  "leased",
  "passthrough",
]);

export const zapiConnectionStateEnum = pgEnum("zapi_connection_state", [
  "unknown",
  "connected",
  "disconnected",
  "pending",
  "errored",
]);

export const zapiConnectionEventSourceEnum = pgEnum("zapi_connection_event_source", [
  "webhook",
  "poll",
  "bootstrap",
  "manual",
]);

export const zapiDeviceSnapshotSourceEnum = pgEnum("zapi_device_snapshot_source", [
  "api_device",
  "webhook",
  "bootstrap",
  "manual",
]);

export const messagingProviderInstances = pgTable(
  "messaging_provider_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    protocol: messagingProtocolEnum("protocol").notNull(),
    providerKind: messagingProviderKindEnum("provider_kind").notNull(),
    displayName: text("display_name").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    executionStrategy: executionStrategyEnum("execution_strategy").notNull().default("leased"),
    redisKey: text("redis_key"),
    cooldownMinMs: integer("cooldown_min_ms"),
    cooldownMaxMs: integer("cooldown_max_ms"),
    safetyTtlMs: integer("safety_ttl_ms"),
    heartbeatIntervalMs: integer("heartbeat_interval_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    protocolEnabledIdx: index("messaging_provider_instances_protocol_enabled_idx").on(
      table.protocol,
      table.isEnabled
    ),
    providerKindIdx: index("messaging_provider_instances_provider_kind_idx").on(
      table.providerKind
    ),
  })
);

export const zapiInstances = pgTable(
  "zapi_instances",
  {
    messagingProviderInstanceId: uuid("messaging_provider_instance_id")
      .primaryKey()
      .references(() => messagingProviderInstances.id, { onDelete: "cascade" }),
    zapiInstanceId: text("zapi_instance_id").notNull(),
    instanceToken: text("instance_token").notNull(),
    webhookBaseUrl: text("webhook_base_url"),
    currentConnectionState: zapiConnectionStateEnum("current_connection_state"),
    currentStatusReason: text("current_status_reason"),
    currentConnected: boolean("current_connected"),
    currentSmartphoneConnected: boolean("current_smartphone_connected"),
    currentPhoneNumber: text("current_phone_number"),
    currentProfileName: text("current_profile_name"),
    currentProfileAbout: text("current_profile_about"),
    currentProfileImageUrl: text("current_profile_image_url"),
    currentOriginalDevice: text("current_original_device"),
    currentSessionId: integer("current_session_id"),
    currentDeviceSessionName: text("current_device_session_name"),
    currentDeviceModel: text("current_device_model"),
    currentIsBusiness: boolean("current_is_business"),
    lastStatusSyncedAt: timestamp("last_status_synced_at", { withTimezone: true }),
    lastDeviceSyncedAt: timestamp("last_device_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    zapiInstanceIdIdx: uniqueIndex("zapi_instances_zapi_instance_id_idx").on(table.zapiInstanceId),
  })
);

export const zapiInstanceConnectionEvents = pgTable(
  "zapi_instance_connection_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messagingProviderInstanceId: uuid("messaging_provider_instance_id")
      .notNull()
      .references(() => messagingProviderInstances.id, { onDelete: "cascade" }),
    source: zapiConnectionEventSourceEnum("source").notNull(),
    eventType: text("event_type").notNull(),
    connected: boolean("connected"),
    smartphoneConnected: boolean("smartphone_connected"),
    statusReason: text("status_reason"),
    providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: text("dedupe_key"),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
  },
  (table) => ({
    providerInstanceIdx: index("zapi_instance_connection_events_provider_instance_idx").on(
      table.messagingProviderInstanceId,
      table.receivedAt
    ),
    dedupeKeyIdx: uniqueIndex("zapi_instance_connection_events_dedupe_key_idx").on(
      table.dedupeKey
    ),
  })
);

export const zapiInstanceDeviceSnapshots = pgTable(
  "zapi_instance_device_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messagingProviderInstanceId: uuid("messaging_provider_instance_id")
      .notNull()
      .references(() => messagingProviderInstances.id, { onDelete: "cascade" }),
    source: zapiDeviceSnapshotSourceEnum("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    phoneNumber: text("phone_number"),
    profileName: text("profile_name"),
    profileAbout: text("profile_about"),
    profileImageUrl: text("profile_image_url"),
    originalDevice: text("original_device"),
    sessionId: integer("session_id"),
    deviceSessionName: text("device_session_name"),
    deviceModel: text("device_model"),
    isBusiness: boolean("is_business"),
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
  },
  (table) => ({
    providerInstanceIdx: index("zapi_instance_device_snapshots_provider_instance_idx").on(
      table.messagingProviderInstanceId,
      table.observedAt
    ),
  })
);

export const messagingProviderInstancesRelations = relations(
  messagingProviderInstances,
  ({ one, many }) => ({
    zapiInstance: one(zapiInstances, {
      fields: [messagingProviderInstances.id],
      references: [zapiInstances.messagingProviderInstanceId],
    }),
    zapiConnectionEvents: many(zapiInstanceConnectionEvents),
    zapiDeviceSnapshots: many(zapiInstanceDeviceSnapshots),
  })
);

export const zapiInstancesRelations = relations(zapiInstances, ({ one, many }) => ({
  providerInstance: one(messagingProviderInstances, {
    fields: [zapiInstances.messagingProviderInstanceId],
    references: [messagingProviderInstances.id],
  }),
  connectionEvents: many(zapiInstanceConnectionEvents),
  deviceSnapshots: many(zapiInstanceDeviceSnapshots),
}));

export const zapiInstanceConnectionEventsRelations = relations(
  zapiInstanceConnectionEvents,
  ({ one }) => ({
    providerInstance: one(messagingProviderInstances, {
      fields: [zapiInstanceConnectionEvents.messagingProviderInstanceId],
      references: [messagingProviderInstances.id],
    }),
  })
);

export const zapiInstanceDeviceSnapshotsRelations = relations(
  zapiInstanceDeviceSnapshots,
  ({ one }) => ({
    providerInstance: one(messagingProviderInstances, {
      fields: [zapiInstanceDeviceSnapshots.messagingProviderInstanceId],
      references: [messagingProviderInstances.id],
    }),
  })
);

export type MessagingProviderInstance = typeof messagingProviderInstances.$inferSelect;
export type NewMessagingProviderInstance = typeof messagingProviderInstances.$inferInsert;

export type ZApiInstance = typeof zapiInstances.$inferSelect;
export type NewZApiInstance = typeof zapiInstances.$inferInsert;

export type ZApiInstanceConnectionEvent = typeof zapiInstanceConnectionEvents.$inferSelect;
export type NewZApiInstanceConnectionEvent = typeof zapiInstanceConnectionEvents.$inferInsert;

export type ZApiInstanceDeviceSnapshot = typeof zapiInstanceDeviceSnapshots.$inferSelect;
export type NewZApiInstanceDeviceSnapshot = typeof zapiInstanceDeviceSnapshots.$inferInsert;