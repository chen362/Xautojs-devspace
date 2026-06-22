import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresDatabaseConfig } from "./types.js";

type QueryValue = string | boolean | number | null;

export const POSTGRES_SCHEMA_MIGRATIONS_TABLE = "devspace_schema_migrations";

export interface PostgresMigrationQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PostgresMigrationClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: QueryValue[],
  ): Promise<PostgresMigrationQueryResult<Row>>;
  release(): void;
}

export interface PostgresMigrationPool {
  connect(): Promise<PostgresMigrationClient>;
  end(): Promise<void>;
}

interface PgPoolConstructor {
  new (config: {
    connectionString: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    application_name: string;
    max: number;
  }): PostgresMigrationPool;
}

export interface PostgresMigration {
  version: string;
  name: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface AppliedPostgresMigration {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;
}

export type PostgresMigrationState = "applied" | "pending" | "modified";
export type PostgresSchemaState = "ready" | "missing" | "pending" | "modified";

export interface PostgresMigrationStatusEntry {
  version: string;
  name: string;
  checksum: string;
  state: PostgresMigrationState;
  appliedAt?: string;
}

export interface PostgresMigrationStatus {
  migrationsDir: string;
  tableName: string;
  tableExists: boolean;
  migrations: PostgresMigrationStatusEntry[];
  appliedCount: number;
  pendingCount: number;
  modifiedCount: number;
}

export interface PostgresMigrationStatusJson {
  state: PostgresSchemaState;
  ready: boolean;
  migrationsDir: string;
  tableName: string;
  tableExists: boolean;
  appliedCount: number;
  pendingCount: number;
  modifiedCount: number;
  migrations: PostgresMigrationStatusEntry[];
}

export interface PostgresMigrationResult {
  migrationsDir: string;
  applied: PostgresMigration[];
  status: PostgresMigrationStatus;
}

export interface PostgresMigrationOptions {
  migrationsDir?: string;
  pool?: PostgresMigrationPool;
}

export async function loadPostgresMigrations(
  migrationsDir = defaultPostgresMigrationsDir(),
): Promise<PostgresMigration[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(
    files.map(async (name) => {
      const path = join(migrationsDir, name);
      const sql = await readFile(path, "utf8");
      return {
        version: name.replace(/\.sql$/, ""),
        name,
        path,
        sql,
        checksum: checksum(sql),
      };
    }),
  );
}

export async function getPostgresMigrationStatus(
  config: PostgresDatabaseConfig,
  options: PostgresMigrationOptions = {},
): Promise<PostgresMigrationStatus> {
  const migrationsDir = options.migrationsDir ?? defaultPostgresMigrationsDir();
  const migrations = await loadPostgresMigrations(migrationsDir);

  return withPostgresMigrationPool(config, options, async (pool) => {
    const client = await pool.connect();
    try {
      const tableExists = await schemaMigrationsTableExists(client);
      const applied = tableExists ? await readAppliedMigrations(client) : [];
      return buildMigrationStatus({ migrationsDir, migrations, applied, tableExists });
    } finally {
      client.release();
    }
  });
}

export async function migratePostgresDatabase(
  config: PostgresDatabaseConfig,
  options: PostgresMigrationOptions = {},
): Promise<PostgresMigrationResult> {
  const migrationsDir = options.migrationsDir ?? defaultPostgresMigrationsDir();
  const migrations = await loadPostgresMigrations(migrationsDir);

  return withPostgresMigrationPool(config, options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await ensureSchemaMigrationsTable(client);
      const applied = await readAppliedMigrations(client);
      const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));
      const appliedNow: PostgresMigration[] = [];

      for (const migration of migrations) {
        const existing = appliedByVersion.get(migration.version);
        if (existing) {
          if (existing.checksum !== migration.checksum) {
            throw new Error(
              `Postgres migration checksum mismatch for ${migration.name}. Refusing to continue.`,
            );
          }
          continue;
        }

        await client.query(migration.sql);
        await client.query(
          `
            insert into ${POSTGRES_SCHEMA_MIGRATIONS_TABLE} (
              version,
              name,
              checksum,
              applied_at
            ) values ($1, $2, $3, now())
          `,
          [migration.version, migration.name, migration.checksum],
        );
        appliedByVersion.set(migration.version, {
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          appliedAt: new Date().toISOString(),
        });
        appliedNow.push(migration);
      }

      await client.query("commit");
      return {
        migrationsDir,
        applied: appliedNow,
        status: buildMigrationStatus({
          migrationsDir,
          migrations,
          applied: Array.from(appliedByVersion.values()),
          tableExists: true,
        }),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function assertPostgresSchemaReady(
  config: PostgresDatabaseConfig,
  options: PostgresMigrationOptions = {},
): Promise<void> {
  const status = await getPostgresMigrationStatus(config, options);
  if (postgresSchemaState(status) === "ready") return;

  throw new Error(
    [
      "Postgres schema is not ready.",
      `Schema migrations table: ${status.tableExists ? status.tableName : "missing"}`,
      `Pending migrations: ${status.pendingCount}`,
      `Modified migrations: ${status.modifiedCount}`,
      "",
      "Run:",
      "  devspace db migrate",
    ].join("\n"),
  );
}

export function formatPostgresMigrationStatus(status: PostgresMigrationStatus): string {
  const lines = [
    `Migrations directory: ${status.migrationsDir}`,
    `Schema migrations table: ${status.tableExists ? status.tableName : "missing"}`,
    `Migrations: ${status.appliedCount} applied, ${status.pendingCount} pending, ${status.modifiedCount} modified`,
  ];

  const modified = status.migrations.filter((migration) => migration.state === "modified");
  const pending = status.migrations.filter((migration) => migration.state === "pending");
  if (modified.length > 0) {
    lines.push("", "Modified migrations:", ...modified.map((migration) => `  ${migration.name}`));
  }
  if (pending.length > 0) {
    lines.push("", "Pending migrations:", ...pending.map((migration) => `  ${migration.name}`));
  }
  if (modified.length === 0 && pending.length === 0) {
    lines.push("", "Database schema is up to date.");
  }

  return lines.join("\n");
}

export function formatPostgresMigrationResult(result: PostgresMigrationResult): string {
  if (result.applied.length === 0) return "Database schema is up to date.";
  return [
    `Applied ${result.applied.length} migration${result.applied.length === 1 ? "" : "s"}:`,
    ...result.applied.map((migration) => `  ${migration.name}`),
  ].join("\n");
}

export function postgresSchemaState(status: PostgresMigrationStatus): PostgresSchemaState {
  if (!status.tableExists) return "missing";
  if (status.modifiedCount > 0) return "modified";
  if (status.pendingCount > 0) return "pending";
  return "ready";
}

export function toPostgresMigrationStatusJson(
  status: PostgresMigrationStatus,
): PostgresMigrationStatusJson {
  const state = postgresSchemaState(status);
  return {
    state,
    ready: state === "ready",
    migrationsDir: status.migrationsDir,
    tableName: status.tableName,
    tableExists: status.tableExists,
    appliedCount: status.appliedCount,
    pendingCount: status.pendingCount,
    modifiedCount: status.modifiedCount,
    migrations: status.migrations,
  };
}

function buildMigrationStatus(input: {
  migrationsDir: string;
  migrations: PostgresMigration[];
  applied: AppliedPostgresMigration[];
  tableExists: boolean;
}): PostgresMigrationStatus {
  const appliedByVersion = new Map(input.applied.map((migration) => [migration.version, migration]));
  const migrations = input.migrations.map((migration): PostgresMigrationStatusEntry => {
    const applied = appliedByVersion.get(migration.version);
    if (!applied) {
      return {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
        state: "pending",
      };
    }

    return {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      state: applied.checksum === migration.checksum ? "applied" : "modified",
      appliedAt: applied.appliedAt,
    };
  });

  return {
    migrationsDir: input.migrationsDir,
    tableName: POSTGRES_SCHEMA_MIGRATIONS_TABLE,
    tableExists: input.tableExists,
    migrations,
    appliedCount: migrations.filter((migration) => migration.state === "applied").length,
    pendingCount: migrations.filter((migration) => migration.state === "pending").length,
    modifiedCount: migrations.filter((migration) => migration.state === "modified").length,
  };
}

async function withPostgresMigrationPool<T>(
  config: PostgresDatabaseConfig,
  options: PostgresMigrationOptions,
  run: (pool: PostgresMigrationPool) => Promise<T>,
): Promise<T> {
  if (options.pool) return run(options.pool);

  const pool = await createPgPool(config);
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

async function schemaMigrationsTableExists(client: PostgresMigrationClient): Promise<boolean> {
  const result = await client.query<{ table_name: string | null }>(
    "select to_regclass($1) as table_name",
    [POSTGRES_SCHEMA_MIGRATIONS_TABLE],
  );
  return result.rows[0]?.table_name !== null && result.rows[0]?.table_name !== undefined;
}

async function ensureSchemaMigrationsTable(client: PostgresMigrationClient): Promise<void> {
  await client.query(`
    create table if not exists ${POSTGRES_SCHEMA_MIGRATIONS_TABLE} (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readAppliedMigrations(
  client: PostgresMigrationClient,
): Promise<AppliedPostgresMigration[]> {
  const result = await client.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: string | Date;
  }>(`
    select version, name, checksum, applied_at
    from ${POSTGRES_SCHEMA_MIGRATIONS_TABLE}
    order by version asc
  `);

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : row.applied_at,
  }));
}

async function createPgPool(config: PostgresDatabaseConfig): Promise<PostgresMigrationPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace-migrations",
    max: 1,
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
    if (!Pool) throw new Error("The pg module did not export Pool.");
    return Pool;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingPgDependency(message)) {
      throw new Error(
        "Postgres migrations require the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
      );
    }
    throw error;
  }
}

function defaultPostgresMigrationsDir(): string {
  return fileURLToPath(new URL("../../migrations/postgres/", import.meta.url));
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function isMissingPgDependency(message: string): boolean {
  return message.includes("Cannot find package 'pg'") || message.includes("Cannot find module 'pg'");
}

function sslFor(config: PostgresDatabaseConfig): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}
