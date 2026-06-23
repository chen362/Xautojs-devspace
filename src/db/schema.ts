import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    userId: text("user_id").notNull().default("owner"),
    mcpSessionId: text("mcp_session_id"),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_owner_idx").on(table.tenantId, table.userId, table.lastUsedAt),
    index("workspace_sessions_owner_mcp_session_idx").on(
      table.tenantId,
      table.userId,
      table.mcpSessionId,
      table.lastUsedAt,
    ),
    index("workspace_sessions_owner_root_idx").on(table.tenantId, table.userId, table.root, table.lastUsedAt),
    index("workspace_sessions_owner_status_idx").on(table.tenantId, table.userId, table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
  (table) => [index("oauth_clients_issued_at_idx").on(table.issuedAt)],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
  (table) => [
    index("oauth_access_tokens_client_id_idx").on(table.clientId),
    index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
  (table) => [
    index("oauth_refresh_tokens_client_id_idx").on(table.clientId),
    index("oauth_refresh_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OAuthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
