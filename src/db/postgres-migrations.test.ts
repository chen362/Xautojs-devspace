import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostgresDatabaseConfig } from "./types.js";
import {
  POSTGRES_SCHEMA_MIGRATIONS_TABLE,
  assertPostgresSchemaReady,
  formatPostgresMigrationResult,
  formatPostgresMigrationStatus,
  getPostgresMigrationStatus,
  migratePostgresDatabase,
  type AppliedPostgresMigration,
  type PostgresMigrationClient,
  type PostgresMigrationPool,
  type PostgresMigrationQueryResult,
} from "./postgres-migrations.js";

class FakeMigrationPool implements PostgresMigrationPool {
  constructor(private readonly client: FakeMigrationClient) {}

  async connect(): Promise<PostgresMigrationClient> {
    return this.client;
  }

  async end(): Promise<void> {}
}

class FakeMigrationClient implements PostgresMigrationClient {
  tableExists = false;
  readonly applied = new Map<string, AppliedPostgresMigration>();
  readonly executedMigrationSql: string[] = [];

  async query<Row = Record<string, unknown>>(
    text: string,
    values: Array<string | boolean | number | null> = [],
  ): Promise<PostgresMigrationQueryResult<Row>> {
    const normalizedSql = text.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalizedSql === "begin" || normalizedSql === "commit" || normalizedSql === "rollback") {
      return emptyResult<Row>();
    }

    if (normalizedSql.startsWith("select to_regclass")) {
      return {
        rows: [{ table_name: this.tableExists ? POSTGRES_SCHEMA_MIGRATIONS_TABLE : null }] as Row[],
        rowCount: 1,
      };
    }

    if (normalizedSql.startsWith(`create table if not exists ${POSTGRES_SCHEMA_MIGRATIONS_TABLE}`)) {
      this.tableExists = true;
      return emptyResult<Row>();
    }

    if (normalizedSql.startsWith("select version, name, checksum, applied_at")) {
      return {
        rows: Array.from(this.applied.values()).map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          applied_at: migration.appliedAt,
        })) as Row[],
        rowCount: this.applied.size,
      };
    }

    if (normalizedSql.startsWith(`insert into ${POSTGRES_SCHEMA_MIGRATIONS_TABLE}`)) {
      const [version, name, checksum] = values;
      this.applied.set(stringValue(version), {
        version: stringValue(version),
        name: stringValue(name),
        checksum: stringValue(checksum),
        appliedAt: "2026-01-01T00:00:00.000Z",
      });
      return emptyResult<Row>();
    }

    this.executedMigrationSql.push(text);
    return emptyResult<Row>();
  }

  release(): void {}
}

const migrationsDir = await mkdtemp(join(tmpdir(), "devspace-postgres-migrations-test-"));
const config: PostgresDatabaseConfig = {
  provider: "postgres",
  url: "postgres://devspace:secret@db.example.com:5432/devspace",
  sslMode: "disable",
};
const client = new FakeMigrationClient();
const pool = new FakeMigrationPool(client);

try {
  await writeFile(join(migrationsDir, "0001_workspace_sessions.sql"), "create table workspace_sessions (id text primary key);\n");
  await writeFile(join(migrationsDir, "0002_loaded_agent_files.sql"), "create table loaded_agent_files (path text primary key);\n");

  const initialStatus = await getPostgresMigrationStatus(config, { migrationsDir, pool });
  assert.equal(initialStatus.tableExists, false);
  assert.equal(initialStatus.pendingCount, 2);
  assert.match(formatPostgresMigrationStatus(initialStatus), /Schema migrations table: missing/);

  await assert.rejects(
    () => assertPostgresSchemaReady(config, { migrationsDir, pool }),
    /Postgres schema is not ready/,
  );

  const result = await migratePostgresDatabase(config, { migrationsDir, pool });
  assert.deepEqual(
    result.applied.map((migration) => migration.name),
    ["0001_workspace_sessions.sql", "0002_loaded_agent_files.sql"],
  );
  assert.equal(client.tableExists, true);
  assert.equal(client.applied.size, 2);
  assert.equal(client.executedMigrationSql.length, 2);
  assert.match(formatPostgresMigrationResult(result), /Applied 2 migrations/);

  const readyStatus = await getPostgresMigrationStatus(config, { migrationsDir, pool });
  assert.equal(readyStatus.tableExists, true);
  assert.equal(readyStatus.appliedCount, 2);
  assert.equal(readyStatus.pendingCount, 0);
  assert.equal(readyStatus.modifiedCount, 0);
  assert.match(formatPostgresMigrationStatus(readyStatus), /Database schema is up to date/);
  await assertPostgresSchemaReady(config, { migrationsDir, pool });

  const noopResult = await migratePostgresDatabase(config, { migrationsDir, pool });
  assert.equal(noopResult.applied.length, 0);
  assert.equal(formatPostgresMigrationResult(noopResult), "Database schema is up to date.");

  await writeFile(join(migrationsDir, "0002_loaded_agent_files.sql"), "create table loaded_agent_files (path text primary key);\n-- changed\n");
  const driftStatus = await getPostgresMigrationStatus(config, { migrationsDir, pool });
  assert.equal(driftStatus.modifiedCount, 1);
  assert.equal(driftStatus.migrations.find((migration) => migration.name === "0002_loaded_agent_files.sql")?.state, "modified");
  await assert.rejects(
    () => migratePostgresDatabase(config, { migrationsDir, pool }),
    /checksum mismatch/,
  );
} finally {
  await rm(migrationsDir, { recursive: true, force: true });
}

function emptyResult<Row>(): PostgresMigrationQueryResult<Row> {
  return { rows: [], rowCount: 0 };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}
