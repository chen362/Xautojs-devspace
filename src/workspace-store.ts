import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import {
  workspaceSessions,
  type WorkspaceSessionRow,
} from "./db/schema.js";
import type { DatabaseConfig } from "./db/types.js";
import { LOCAL_WORKSPACE_IDENTITY, type WorkspaceIdentity } from "./identity.js";
import { PostgresWorkspaceStore } from "./postgres-workspace-store.js";

export type WorkspaceMode = "checkout" | "worktree";

export interface WorkspaceSessionScope {
  mcpSessionId?: string;
}

export interface WorkspaceSession {
  id: string;
  tenantId: string;
  userId: string;
  mcpSessionId?: string;
  root: string;
  status: string;
  mode: WorkspaceMode;
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managed: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface LoadedAgentFileInput {
  path: string;
  content: string;
}

export interface LoadedAgentFile {
  path: string;
  contentHash: string;
  content: string;
  loadedAt: string;
  lastSeenAt: string;
}

interface StoredLoadedAgentFileRow {
  path: string;
  content_hash: string;
  content: string;
  loaded_at: string;
  last_seen_at: string;
}

export interface WorkspaceStore {
  createSession(input: {
    owner: WorkspaceIdentity;
    id: string;
    root: string;
    mcpSessionId?: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): Promise<WorkspaceSession>;
  getSession(
    id: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<WorkspaceSession | undefined>;
  saveLoadedAgentFiles(input: {
    owner: WorkspaceIdentity;
    workspaceSessionId: string;
    files: LoadedAgentFileInput[];
    scope?: WorkspaceSessionScope;
  }): Promise<void>;
  getLoadedAgentFiles(
    workspaceSessionId: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<LoadedAgentFile[]>;
  deleteSession(
    id: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<boolean>;
  deleteExpiredSessions(cutoff: string): Promise<number>;
  touchSession(id: string, owner: WorkspaceIdentity, scope?: WorkspaceSessionScope): Promise<void>;
  close?(): Promise<void>;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.migrate();
  }

  async createSession(input: {
    owner: WorkspaceIdentity;
    id: string;
    root: string;
    mcpSessionId?: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): Promise<WorkspaceSession> {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
      mcpSessionId: input.mcpSessionId,
      root: input.root,
      status: "active",
      mode: input.mode ?? "checkout",
      sourceRoot: input.sourceRoot,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
      managed: input.managed ?? false,
      createdAt: now,
      lastUsedAt: now,
    };

    this.database.db
      .insert(workspaceSessions)
      .values({
        id: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        mcpSessionId: session.mcpSessionId ?? null,
        root: session.root,
        status: session.status,
        mode: session.mode,
        sourceRoot: session.sourceRoot ?? null,
        baseRef: session.baseRef ?? null,
        baseSha: session.baseSha ?? null,
        managed: String(session.managed),
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
      })
      .run();

    return session;
  }

  async getSession(
    id: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<WorkspaceSession | undefined> {
    const row = this.database.db
      .select()
      .from(workspaceSessions)
      .where(ownerSessionFilter(id, owner, scope))
      .get();

    return row ? rowToWorkspaceSession(row) : undefined;
  }

  async saveLoadedAgentFiles(input: {
    owner: WorkspaceIdentity;
    workspaceSessionId: string;
    files: LoadedAgentFileInput[];
    scope?: WorkspaceSessionScope;
  }): Promise<void> {
    const session = await this.getSession(input.workspaceSessionId, input.owner, input.scope);
    if (!session) return;

    const now = new Date().toISOString();
    const replaceFiles = this.database.sqlite.transaction((files: LoadedAgentFileInput[]) => {
      this.database.sqlite
        .prepare("delete from loaded_agent_files where workspace_session_id = ?")
        .run(input.workspaceSessionId);

      const insert = this.database.sqlite.prepare(`
        insert into loaded_agent_files (
          workspace_session_id,
          path,
          content_hash,
          content,
          loaded_at,
          last_seen_at
        ) values (?, ?, ?, ?, ?, ?)
      `);

      for (const file of files) {
        insert.run(
          input.workspaceSessionId,
          file.path,
          hashLoadedAgentFileContent(file.content),
          file.content,
          now,
          now,
        );
      }
    });

    replaceFiles(input.files);
  }

  async getLoadedAgentFiles(
    workspaceSessionId: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<LoadedAgentFile[]> {
    const mcpSessionId = scope?.mcpSessionId ?? null;
    const rows = this.database.sqlite
      .prepare(`
        select
          files.path,
          files.content_hash,
          files.content,
          files.loaded_at,
          files.last_seen_at
        from loaded_agent_files files
        inner join workspace_sessions sessions
          on sessions.id = files.workspace_session_id
        where files.workspace_session_id = ?
          and sessions.tenant_id = ?
          and sessions.user_id = ?
          and (? is null or sessions.mcp_session_id = ?)
        order by files.path asc
      `)
      .all(workspaceSessionId, owner.tenantId, owner.userId, mcpSessionId, mcpSessionId) as StoredLoadedAgentFileRow[];

    return rows.map(rowToLoadedAgentFile);
  }

  async deleteSession(
    id: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<boolean> {
    const mcpSessionId = scope?.mcpSessionId ?? null;
    const result = this.database.sqlite
      .prepare(`
        delete from workspace_sessions
        where id = ?
          and tenant_id = ?
          and user_id = ?
          and (? is null or mcp_session_id = ?)
      `)
      .run(id, owner.tenantId, owner.userId, mcpSessionId, mcpSessionId);

    return result.changes > 0;
  }

  async deleteExpiredSessions(cutoff: string): Promise<number> {
    const result = this.database.sqlite
      .prepare("delete from workspace_sessions where last_used_at < ?")
      .run(cutoff);

    return result.changes;
  }

  async touchSession(
    id: string,
    owner: WorkspaceIdentity,
    scope?: WorkspaceSessionScope,
  ): Promise<void> {
    this.database.db
      .update(workspaceSessions)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(ownerSessionFilter(id, owner, scope))
      .run();
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private migrate(): void {
    this.database.sqlite.exec(`
      create table if not exists workspace_sessions (
        id text primary key,
        tenant_id text not null default 'local',
        user_id text not null default 'owner',
        mcp_session_id text,
        root text not null,
        status text not null default 'active',
        mode text not null default 'checkout',
        source_root text,
        base_ref text,
        base_sha text,
        managed text not null default 'false',
        created_at text not null,
        last_used_at text not null
      );

      create table if not exists loaded_agent_files (
        workspace_session_id text not null,
        path text not null,
        content_hash text not null,
        content text not null,
        loaded_at text not null,
        last_seen_at text not null,
        primary key (workspace_session_id, path),
        foreign key (workspace_session_id)
          references workspace_sessions(id)
          on delete cascade
      );

      create index if not exists loaded_agent_files_path_idx
        on loaded_agent_files(path);
    `);

    this.addColumnIfMissing("workspace_sessions", "tenant_id", "text not null default 'local'");
    this.addColumnIfMissing("workspace_sessions", "user_id", "text not null default 'owner'");
    this.addColumnIfMissing("workspace_sessions", "mcp_session_id", "text");
    this.addColumnIfMissing("workspace_sessions", "mode", "text not null default 'checkout'");
    this.addColumnIfMissing("workspace_sessions", "source_root", "text");
    this.addColumnIfMissing("workspace_sessions", "base_ref", "text");
    this.addColumnIfMissing("workspace_sessions", "base_sha", "text");
    this.addColumnIfMissing("workspace_sessions", "managed", "text not null default 'false'");
    this.database.sqlite.exec(`
      create index if not exists workspace_sessions_owner_idx
        on workspace_sessions(tenant_id, user_id, last_used_at desc);

      create index if not exists workspace_sessions_owner_mcp_session_idx
        on workspace_sessions(tenant_id, user_id, mcp_session_id, last_used_at desc);

      create index if not exists workspace_sessions_owner_root_idx
        on workspace_sessions(tenant_id, user_id, root, last_used_at desc);

      create index if not exists workspace_sessions_owner_status_idx
        on workspace_sessions(tenant_id, user_id, status, last_used_at desc);

      create index if not exists workspace_sessions_last_used_idx
        on workspace_sessions(last_used_at);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((existingColumn) => existingColumn.name === column)) return;

    this.database.sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

export function createWorkspaceStore(config: string | DatabaseConfig): WorkspaceStore {
  if (typeof config === "string") return new SqliteWorkspaceStore(config);
  if (config.provider === "postgres") return new PostgresWorkspaceStore(config);
  return new SqliteWorkspaceStore(config.stateDir);
}

function ownerSessionFilter(
  id: string,
  owner: WorkspaceIdentity,
  scope: WorkspaceSessionScope | undefined,
) {
  if (scope?.mcpSessionId) {
    return and(
      eq(workspaceSessions.id, id),
      eq(workspaceSessions.tenantId, owner.tenantId),
      eq(workspaceSessions.userId, owner.userId),
      eq(workspaceSessions.mcpSessionId, scope.mcpSessionId),
    );
  }

  return and(
    eq(workspaceSessions.id, id),
    eq(workspaceSessions.tenantId, owner.tenantId),
    eq(workspaceSessions.userId, owner.userId),
  );
}

function rowToWorkspaceSession(row: WorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    tenantId: row.tenantId ?? LOCAL_WORKSPACE_IDENTITY.tenantId,
    userId: row.userId ?? LOCAL_WORKSPACE_IDENTITY.userId,
    mcpSessionId: row.mcpSessionId ?? undefined,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.sourceRoot ?? undefined,
    baseRef: row.baseRef ?? undefined,
    baseSha: row.baseSha ?? undefined,
    managed: row.managed === "true",
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function rowToLoadedAgentFile(row: StoredLoadedAgentFileRow): LoadedAgentFile {
  return {
    path: row.path,
    contentHash: row.content_hash,
    content: row.content,
    loadedAt: row.loaded_at,
    lastSeenAt: row.last_seen_at,
  };
}

function hashLoadedAgentFileContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
