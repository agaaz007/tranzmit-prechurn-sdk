/**
 * Database schema for Exit Button backend
 * Uses Drizzle ORM with PostgreSQL
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Tenants ─────────────────────────────────────────────────────────────────

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),
  allowedOrigins: text('allowed_origins').array().default([]),
  posthogApiKey: text('posthog_api_key'),
  posthogProjectId: text('posthog_project_id'),
  posthogHost: text('posthog_host'),
  elevenLabsApiKey: text('elevenlabs_api_key'),
  interventionAgentId: text('intervention_agent_id'),
  chatAgentId: text('chat_agent_id'),
  createdAt: timestamp('created_at').defaultNow(),
});

// ─── API Keys ────────────────────────────────────────────────────────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  keyHash: text('key_hash').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
});

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('initiated'),
  agentId: text('agent_id'),
  context: text('context'),
  dynamicVariables: jsonb('dynamic_variables'),
  transcript: jsonb('transcript'),
  offers: jsonb('offers'),
  outcome: text('outcome'),
  aiAnalysis: jsonb('ai_analysis'),
  timing: jsonb('timing'),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

// ─── Relations ───────────────────────────────────────────────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  apiKeys: many(apiKeys),
  sessions: many(sessions),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, {
    fields: [apiKeys.tenantId],
    references: [tenants.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [sessions.tenantId],
    references: [tenants.id],
  }),
}));

// ─── Widget Triggers ─────────────────────────────────────────────────────────

export const widgetTriggers = pgTable('widget_triggers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  distinctId: text('distinct_id').notNull(),
  userName: text('user_name'),
  status: text('status').notNull().default('pending'), // pending | shown | clicked | dismissed
  expiresAt: timestamp('expires_at').notNull(),
  shownAt: timestamp('shown_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const widgetTriggersRelations = relations(widgetTriggers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [widgetTriggers.tenantId],
    references: [tenants.id],
  }),
}));
