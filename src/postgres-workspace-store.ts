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
  query: PostgresQuery,
) => Promise<PostgresQueryResult<Row>>;

interface PgPoolResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface PgPool {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: QueryValue[],
  ): Promise<PgPoolResult<Row>>;
  end(): Promise<void>;
}

interface PgPoolConstructor {
  new (config: {
    connectionString: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    application_name: string;
    max: number;
  }): PgPool;
}

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
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresQueryRunner,
  ) {}

  async createSession(input: {
    owner: WorkspaceIdentity;
    id: string;
    root: string;
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

    await this.query({
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

  async getSession(id: string, owner: WorkspaceIdentity): Promise<WorkspaceSession | undefined> {
    const result = await this.query<PostgresWorkspaceSessionRow>({
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

  async touchSession(id: string, owner: WorkspaceIdentity): Promise<void> {
    await this.query({
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

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresQuery,
  ): Promise<PostgresQueryResult<Row>> {
    if (this.queryRunner) return this.queryRunner<Row>(query);

    const pool = await this.pool();
    const result = await pool.query<Row>(query.text, query.values);
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
    };
  }

  private pool(): Promise<PgPool> {
    this.poolPromise ??= createPool(this.config);
    return this.poolPromise;
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

async function createPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace",
    max: 10,
  });
}

async function importPgPool(): Promise<PgPoolConstructor> {
  const moduleName = "pg";

  try {
    const pg = (await import(moduleName)) as {
      Pool?: PgPoolConstructor;
      default?: { Pool?: PgPoolConstructor };
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) {
      throw new Error("The pg module did not export Pool.");
    }

    return Pool;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingPgDependency(message)) {
      throw new PostgresWorkspaceStoreQueryError(
        "Postgres mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
      );
    }

    throw error;
  }
}

function isMissingPgDependency(message: string): boolean {
  return message.includes("Cannot find package 'pg'") || message.includes("Cannot find module 'pg'");
}

function sslFor(config: PostgresDatabaseConfig): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}
