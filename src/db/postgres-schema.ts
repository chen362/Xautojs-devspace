import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const pgTenants = pgTable(
  "tenants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    issuer: text("issuer").notNull(),
    externalTenantId: text("external_tenant_id").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tenants_issuer_external_tenant_id_idx").on(table.issuer, table.externalTenantId),
    index("tenants_status_idx").on(table.status, table.updatedAt),
  ],
);

export const pgTenantUsers = pgTable(
  "tenant_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("tenant_users_tenant_external_user_id_idx").on(table.tenantId, table.externalUserId),
    index("tenant_users_tenant_status_idx").on(table.tenantId, table.status, table.lastSeenAt),
  ],
);

export const pgLocalAgents = pgTable(
  "local_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    agentInstanceId: text("agent_instance_id").notNull(),
    label: text("label"),
    publicBaseUrl: text("public_base_url"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("local_agents_tenant_user_instance_idx").on(table.tenantId, table.userId, table.agentInstanceId),
    index("local_agents_tenant_user_status_idx").on(table.tenantId, table.userId, table.status),
  ],
);

export const pgWorkspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    localAgentId: uuid("local_agent_id").references(() => pgLocalAgents.id, { onDelete: "set null" }),
    displayName: text("display_name"),
    root: text("root").notNull(),
    rootFingerprint: text("root_fingerprint").notNull(),
    defaultMode: text("default_mode").notNull().default("checkout"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workspaces_owner_agent_root_idx").on(
      table.tenantId,
      table.ownerUserId,
      table.localAgentId,
      table.rootFingerprint,
    ),
    index("workspaces_tenant_owner_status_idx").on(table.tenantId, table.ownerUserId, table.status),
  ],
);

export const pgMcpSessions = pgTable(
  "mcp_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("mcp_sessions_tenant_user_status_idx").on(table.tenantId, table.userId, table.status),
    index("mcp_sessions_last_seen_idx").on(table.lastSeenAt),
  ],
);

export const pgWorkspaceSessions = pgTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => pgWorkspaces.id, { onDelete: "set null" }),
    mcpSessionId: text("mcp_session_id").references(() => pgMcpSessions.id, { onDelete: "set null" }),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: boolean("managed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workspace_sessions_tenant_user_idx").on(table.tenantId, table.userId, table.lastUsedAt),
    index("workspace_sessions_workspace_idx").on(table.workspaceId, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.tenantId, table.userId, table.status, table.lastUsedAt),
  ],
);

export const pgLoadedAgentFiles = pgTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => pgWorkspaceSessions.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_tenant_user_path_idx").on(table.tenantId, table.userId, table.path),
  ],
);

export const pgAgentConversations = pgTable(
  "agent_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => pgTenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => pgTenantUsers.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").references(() => pgWorkspaces.id, { onDelete: "set null" }),
    mcpSessionId: text("mcp_session_id").references(() => pgMcpSessions.id, { onDelete: "set null" }),
    providerConversationId: text("provider_conversation_id"),
    title: text("title"),
    status: text("status").notNull().default("active"),
    contextFingerprint: text("context_fingerprint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_conversations_tenant_user_workspace_idx").on(
      table.tenantId,
      table.userId,
      table.workspaceId,
      table.lastActiveAt,
    ),
    index("agent_conversations_provider_idx").on(table.providerConversationId),
  ],
);

export type PgTenantRow = typeof pgTenants.$inferSelect;
export type NewPgTenantRow = typeof pgTenants.$inferInsert;
export type PgTenantUserRow = typeof pgTenantUsers.$inferSelect;
export type NewPgTenantUserRow = typeof pgTenantUsers.$inferInsert;
export type PgLocalAgentRow = typeof pgLocalAgents.$inferSelect;
export type NewPgLocalAgentRow = typeof pgLocalAgents.$inferInsert;
export type PgWorkspaceRow = typeof pgWorkspaces.$inferSelect;
export type NewPgWorkspaceRow = typeof pgWorkspaces.$inferInsert;
export type PgMcpSessionRow = typeof pgMcpSessions.$inferSelect;
export type NewPgMcpSessionRow = typeof pgMcpSessions.$inferInsert;
export type PgWorkspaceSessionRow = typeof pgWorkspaceSessions.$inferSelect;
export type NewPgWorkspaceSessionRow = typeof pgWorkspaceSessions.$inferInsert;
export type PgLoadedAgentFileRow = typeof pgLoadedAgentFiles.$inferSelect;
export type NewPgLoadedAgentFileRow = typeof pgLoadedAgentFiles.$inferInsert;
export type PgAgentConversationRow = typeof pgAgentConversations.$inferSelect;
export type NewPgAgentConversationRow = typeof pgAgentConversations.$inferInsert;
