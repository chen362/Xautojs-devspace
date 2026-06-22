import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  POSTGRES_SCHEMA_MIGRATIONS_TABLE,
  type PostgresMigrationState,
  type PostgresMigrationStatus,
} from "./db/postgres-migrations.js";
import { buildHealthReport, buildReadinessReport } from "./readiness.js";

const configDir = mkdtempSync(join(tmpdir(), "devspace-readiness-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:7676",
};
const now = () => new Date("2026-01-01T00:00:00.000Z");
const uptimeSeconds = () => 12.3456;

const sqliteConfig = loadConfig(baseEnv);
const health = buildHealthReport(sqliteConfig, { now, uptimeSeconds });
assert.equal(health.ok, true);
assert.equal(health.status, "ok");
assert.equal(health.service, "devspace");
assert.equal(health.deploymentMode, "local");
assert.equal(health.timestamp, "2026-01-01T00:00:00.000Z");
assert.equal(health.runtime.uptimeSeconds, 12.346);

const sqliteReady = await buildReadinessReport(sqliteConfig, { now, uptimeSeconds });
assert.equal(sqliteReady.ok, true);
assert.equal(sqliteReady.status, "ready");
assert.equal(sqliteReady.checks.config.databaseProvider, "sqlite");
assert.deepEqual(sqliteReady.checks.database, { ok: true, provider: "sqlite" });

const postgresConfig = loadConfig({
  ...baseEnv,
  DEVSPACE_AUTH_MODE: "oidc",
  DEVSPACE_OIDC_ISSUER: "https://auth.example.com",
  DEVSPACE_OIDC_AUDIENCE: "https://devspace.example.com/mcp",
  DEVSPACE_DATABASE_PROVIDER: "postgres",
  DEVSPACE_DATABASE_URL: "postgres://devspace:secret@db.example.com:5432/devspace",
});

const pendingReady = await buildReadinessReport(postgresConfig, {
  now,
  uptimeSeconds,
  getPostgresMigrationStatus: async () => status({
    tableExists: true,
    appliedCount: 0,
    pendingCount: 1,
    modifiedCount: 0,
    migrationState: "pending",
  }),
});
assert.equal(pendingReady.ok, false);
assert.equal(pendingReady.status, "not_ready");
assert.equal(pendingReady.checks.database.provider, "postgres");
assert.equal(
  pendingReady.checks.database.provider === "postgres"
    ? pendingReady.checks.database.schema?.state
    : undefined,
  "pending",
);

const postgresReady = await buildReadinessReport(postgresConfig, {
  now,
  uptimeSeconds,
  getPostgresMigrationStatus: async () => status({
    tableExists: true,
    appliedCount: 1,
    pendingCount: 0,
    modifiedCount: 0,
    migrationState: "applied",
  }),
});
assert.equal(postgresReady.ok, true);
assert.equal(postgresReady.status, "ready");
assert.equal(
  postgresReady.checks.database.provider === "postgres"
    ? postgresReady.checks.database.schema?.state
    : undefined,
  "ready",
);

const postgresError = await buildReadinessReport(postgresConfig, {
  now,
  uptimeSeconds,
  getPostgresMigrationStatus: async () => {
    throw new Error("connection refused");
  },
});
assert.equal(postgresError.ok, false);
assert.equal(postgresError.status, "not_ready");
assert.equal(
  postgresError.checks.database.provider === "postgres"
    ? postgresError.checks.database.error
    : undefined,
  "connection refused",
);

function status(input: {
  tableExists: boolean;
  appliedCount: number;
  pendingCount: number;
  modifiedCount: number;
  migrationState: PostgresMigrationState;
}): PostgresMigrationStatus {
  return {
    migrationsDir: "/tmp/devspace-migrations",
    tableName: POSTGRES_SCHEMA_MIGRATIONS_TABLE,
    tableExists: input.tableExists,
    appliedCount: input.appliedCount,
    pendingCount: input.pendingCount,
    modifiedCount: input.modifiedCount,
    migrations: [
      {
        version: "0001_workspace_sessions",
        name: "0001_workspace_sessions.sql",
        checksum: "abc123",
        state: input.migrationState,
        ...(input.migrationState === "applied"
          ? { appliedAt: "2026-01-01T00:00:00.000Z" }
          : {}),
      },
    ],
  };
}
