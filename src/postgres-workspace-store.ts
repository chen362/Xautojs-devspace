import { spawnSync } from "node:child_process";
import type { PostgresDatabaseConfig } from "./db/types.js";
import { LOCAL_WORKSPACE_IDENTITY, type WorkspaceIdentity } from "./identity.js";
import type { WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./workspace-store.js";

type QueryValue = string | boolean | null;

export interface PostgresQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresQueryRunner = <Row = Record<string, unknown>>(
  config: PostgresDatabaseConfig,
  query: PostgresQuery,
) => PostgresQueryResult<Row>;

interface PostgresWorkspaceSessionRow {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  base_ref: string | null;
  base_sha: string | null;
  managed: boolean | string | null;
  created_at: string | Date;
  last_used_at: string | Date;
}

export class PostgresWorkspaceStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresWorkspaceStoreQueryError";
  }
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner: PostgresQueryRunner = runPostgresQuery,
  ) {}

  createSession(input: {
    owner: WorkspaceIdentity;
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    const now = new Date().toISOString();
    const session: WorkspaceSession = {
      id: input.id,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
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

    this.queryRunner(this.config, {
      text: `
        insert into workspace_sessions (
          id,
          tenant_id,
          user_id,
          root,
          status,
          mode,
          source_root,
          base_ref,
          base_sha,
          managed,
          created_at,
          last_used_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::timestamptz,
          $12::timestamptz
        )
      `,
      values: [
        session.id,
        session.tenantId,
        session.userId,
        session.root,
        session.status,
        session.mode,
        session.sourceRoot ?? null,
        session.baseRef ?? null,
        session.baseSha ?? null,
        session.managed,
        session.createdAt,
        session.lastUsedAt,
      ],
    });

    return session;
  }

  getSession(id: string, owner: WorkspaceIdentity): WorkspaceSession | undefined {
    const result = this.queryRunner<PostgresWorkspaceSessionRow>(this.config, {
      text: `
        select
          id,
          tenant_id,
          user_id,
          root,
          status,
          mode,
          source_root,
          base_ref,
          base_sha,
          managed,
          created_at,
          last_used_at
        from workspace_sessions
        where id = $1
          and tenant_id = $2
          and user_id = $3
        limit 1
      `,
      values: [id, owner.tenantId, owner.userId],
    });

    const row = result.rows[0];
    return row ? rowToWorkspaceSession(row) : undefined;
  }

  touchSession(id: string, owner: WorkspaceIdentity): void {
    this.queryRunner(this.config, {
      text: `
        update workspace_sessions
        set last_used_at = $4::timestamptz
        where id = $1
          and tenant_id = $2
          and user_id = $3
      `,
      values: [id, owner.tenantId, owner.userId, new Date().toISOString()],
    });
  }

  close(): void {
    // The default runner opens a short-lived worker process per query.
  }
}

function rowToWorkspaceSession(row: PostgresWorkspaceSessionRow): WorkspaceSession {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? LOCAL_WORKSPACE_IDENTITY.tenantId,
    userId: row.user_id ?? LOCAL_WORKSPACE_IDENTITY.userId,
    root: row.root,
    status: row.status,
    mode: row.mode === "worktree" ? "worktree" : "checkout",
    sourceRoot: row.source_root ?? undefined,
    baseRef: row.base_ref ?? undefined,
    baseSha: row.base_sha ?? undefined,
    managed: row.managed === true || row.managed === "true",
    createdAt: toIsoString(row.created_at),
    lastUsedAt: toIsoString(row.last_used_at),
  };
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function runPostgresQuery<Row>(
  config: PostgresDatabaseConfig,
  query: PostgresQuery,
): PostgresQueryResult<Row> {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", POSTGRES_QUERY_WORKER], {
    input: JSON.stringify({ config, query }),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });

  if (child.error) {
    throw new PostgresWorkspaceStoreQueryError(child.error.message);
  }

  const output = child.stdout.trim();
  if (!output) {
    const details = child.stderr.trim() || `worker exited with status ${child.status ?? "unknown"}`;
    throw new PostgresWorkspaceStoreQueryError(details);
  }

  let payload: { ok: true; rows: Row[]; rowCount: number } | { ok: false; error: string };
  try {
    payload = JSON.parse(output) as typeof payload;
  } catch {
    throw new PostgresWorkspaceStoreQueryError(output);
  }

  if (!payload.ok) {
    throw new PostgresWorkspaceStoreQueryError(payload.error);
  }

  return {
    rows: payload.rows,
    rowCount: payload.rowCount,
  };
}

const POSTGRES_QUERY_WORKER = `
const input = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});

function sslFor(config) {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}

try {
  const { Pool } = await import("pg");
  const { config, query } = JSON.parse(input);
  const pool = new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace",
    max: 1,
  });

  try {
    const result = await pool.query(query.text, query.values);
    process.stdout.write(JSON.stringify({
      ok: true,
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
    }));
  } finally {
    await pool.end();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const pgMissing = message.includes("Cannot find package 'pg'") || message.includes('Cannot find module');
  process.stdout.write(JSON.stringify({
    ok: false,
    error: pgMissing
      ? "Postgres mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg"
      : message,
  }));
  process.exitCode = 1;
}
`;
