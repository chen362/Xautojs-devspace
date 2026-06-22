import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createOidcIdentity } from "./identity.js";
import { PostgresAutomationStore } from "./postgres-automation-store.js";
import { PostgresWorkspaceStore } from "./postgres-workspace-store.js";
import {
  assertPostgresSchemaReady,
  getPostgresMigrationStatus,
  migratePostgresDatabase,
} from "./db/postgres-migrations.js";
import type { PostgresDatabaseConfig, PostgresSslMode } from "./db/types.js";

type QueryValue = string | boolean | number | null;

interface PgQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface PgPool {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: QueryValue[],
  ): Promise<PgQueryResult<Row>>;
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

const databaseUrl = process.env.DEVSPACE_DATABASE_URL;

if (!databaseUrl) {
  console.log("Skipping Postgres integration test; set DEVSPACE_DATABASE_URL to run it.");
} else {
  await runPostgresIntegrationTest(databaseUrl, parsePostgresSslMode(process.env.DEVSPACE_POSTGRES_SSL_MODE));
}

async function runPostgresIntegrationTest(
  databaseUrl: string,
  sslMode: PostgresSslMode,
): Promise<void> {
  const schemaName = `devspace_it_${randomUUID().replace(/-/g, "_")}`;
  const adminPool = await createPgPool({
    provider: "postgres",
    url: databaseUrl,
    sslMode,
  });
  let store: PostgresWorkspaceStore | undefined;
  let automationStore: PostgresAutomationStore | undefined;

  try {
    await adminPool.query(`create schema ${quoteIdentifier(schemaName)}`);

    const config: PostgresDatabaseConfig = {
      provider: "postgres",
      url: withSearchPath(databaseUrl, schemaName),
      sslMode,
    };

    const initialStatus = await getPostgresMigrationStatus(config);
    assert.equal(initialStatus.tableExists, false);
    assert.ok(initialStatus.pendingCount > 0);

    const migrationResult = await migratePostgresDatabase(config);
    assert.ok(migrationResult.applied.length > 0);

    const migratedStatus = await getPostgresMigrationStatus(config);
    assert.equal(migratedStatus.tableExists, true);
    assert.equal(migratedStatus.pendingCount, 0);
    assert.equal(migratedStatus.modifiedCount, 0);
    await assertPostgresSchemaReady(config);

    store = new PostgresWorkspaceStore(config);
    automationStore = new PostgresAutomationStore(config);
    const owner = createOidcIdentity({
      issuer: "https://auth.example.com",
      tenantExternalId: "tenant-postgres-it",
      subject: "alice",
      scopes: ["devspace"],
    });
    const otherOwner = createOidcIdentity({
      issuer: "https://auth.example.com",
      tenantExternalId: "tenant-postgres-it",
      subject: "bob",
      scopes: ["devspace"],
    });
    const sessionId = `ws_postgres_it_${randomUUID()}`;

    const created = await store.createSession({
      owner,
      id: sessionId,
      root: "/tmp/devspace-postgres-integration",
      mode: "worktree",
      sourceRoot: "/tmp/devspace-source",
      baseRef: "main",
      baseSha: "abc123",
      managed: true,
    });

    assert.equal(created.tenantId, owner.tenantId);
    assert.equal(created.userId, owner.userId);
    assert.equal(created.mode, "worktree");
    assert.equal(created.managed, true);

    const loaded = await store.getSession(sessionId, owner);
    assert.equal(loaded?.id, sessionId);
    assert.equal(loaded?.root, "/tmp/devspace-postgres-integration");
    assert.equal(loaded?.sourceRoot, "/tmp/devspace-source");
    assert.equal(loaded?.baseRef, "main");
    assert.equal(loaded?.baseSha, "abc123");
    assert.equal(loaded?.managed, true);

    await store.saveLoadedAgentFiles({
      owner,
      workspaceSessionId: sessionId,
      files: [
        { path: "/tmp/devspace-postgres-integration/AGENTS.md", content: "root instructions\n" },
        { path: "/tmp/devspace-postgres-integration/nested/AGENTS.md", content: "nested instructions\n" },
      ],
    });
    const loadedAgentFiles = await store.getLoadedAgentFiles(sessionId, owner);
    assert.deepEqual(
      loadedAgentFiles.map((file) => ({ path: file.path, content: file.content })),
      [
        { path: "/tmp/devspace-postgres-integration/AGENTS.md", content: "root instructions\n" },
        { path: "/tmp/devspace-postgres-integration/nested/AGENTS.md", content: "nested instructions\n" },
      ],
    );
    assert.match(loadedAgentFiles[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);

    const sourceId = `auto_src_it_${randomUUID()}`;
    const source = await automationStore.createSource({
      owner,
      id: sourceId,
      kind: "api_trigger",
      name: "integration trigger",
      secretRef: "secret:automation/integration",
      config: { triggerId: "integration" },
    });
    assert.equal(source.id, sourceId);
    assert.equal(source.tenantId, owner.tenantId);
    assert.equal(source.userId, owner.userId);
    assert.equal(source.kind, "api_trigger");
    assert.deepEqual(source.config, { triggerId: "integration" });
    assert.equal(await automationStore.getSource(sourceId, otherOwner), undefined);

    const eventId = `auto_evt_it_${randomUUID()}`;
    const recorded = await automationStore.recordEvent({
      owner,
      id: eventId,
      sourceId,
      sourceEventId: "provider-event-1",
      idempotencyKey: "idem-event-1",
      requestFingerprint: "sha256:event-1",
      eventType: "automation.trigger.fire",
      payload: { text: "run integration smoke" },
      metadata: { method: "POST" },
      workspaceSessionId: sessionId,
      devspaceConversationId: "conv_postgres_it_1",
    });
    assert.equal(recorded.outcome, "inserted");
    assert.equal(recorded.event.id, eventId);
    assert.deepEqual(recorded.event.payload, { text: "run integration smoke" });

    const duplicate = await automationStore.recordEvent({
      owner,
      id: `auto_evt_it_duplicate_${randomUUID()}`,
      sourceId,
      sourceEventId: "provider-event-1",
      idempotencyKey: "idem-event-1",
      requestFingerprint: "sha256:event-1",
      eventType: "automation.trigger.fire",
    });
    assert.equal(duplicate.outcome, "duplicate");
    assert.equal(duplicate.event.id, eventId);

    await assert.rejects(
      () =>
        automationStore.recordEvent({
          owner,
          id: `auto_evt_it_conflict_${randomUUID()}`,
          sourceId,
          sourceEventId: "provider-event-1",
          idempotencyKey: "idem-event-1",
          requestFingerprint: "sha256:changed",
          eventType: "automation.trigger.fire",
        }),
      /conflicts with existing event/,
    );

    assert.equal(await automationStore.getEvent(eventId, otherOwner), undefined);
    assert.equal((await automationStore.getEvent(eventId, owner))?.id, eventId);

    const runId = `auto_run_it_${randomUUID()}`;
    const run = await automationStore.createRun({
      owner,
      id: runId,
      eventId,
      status: "queued",
      workspaceSessionId: sessionId,
      devspaceConversationId: "conv_postgres_it_1",
      metadata: { queue: "default" },
    });
    assert.equal(run.id, runId);
    assert.equal(run.eventId, eventId);
    assert.equal(run.status, "queued");
    assert.equal(run.attempt, 1);
    assert.deepEqual(run.metadata, { queue: "default" });
    assert.equal(await automationStore.getRun(runId, otherOwner), undefined);
    assert.equal((await automationStore.getRun(runId, owner))?.id, runId);

    assert.equal(await store.getSession(sessionId, otherOwner), undefined);
    assert.deepEqual(await store.getLoadedAgentFiles(sessionId, otherOwner), []);

    await delay(20);
    await store.touchSession(sessionId, owner);
    const touched = await store.getSession(sessionId, owner);
    assert.ok(touched);
    assert.notEqual(touched.lastUsedAt, loaded?.lastUsedAt);

    const expiredSessionId = `ws_postgres_it_expired_${randomUUID()}`;
    await store.createSession({
      owner,
      id: expiredSessionId,
      root: "/tmp/devspace-postgres-expired",
    });
    await store.saveLoadedAgentFiles({
      owner,
      workspaceSessionId: expiredSessionId,
      files: [{ path: "/tmp/devspace-postgres-expired/AGENTS.md", content: "expired instructions\n" }],
    });
    await adminPool.query(
      `update ${quoteIdentifier(schemaName)}.workspace_sessions set last_used_at = $1::timestamptz where id = $2`,
      ["2000-01-01T00:00:00.000Z", expiredSessionId],
    );
    assert.equal(await store.deleteExpiredSessions("2001-01-01T00:00:00.000Z"), 1);
    assert.equal(await store.getSession(expiredSessionId, owner), undefined);
    assert.deepEqual(await store.getLoadedAgentFiles(expiredSessionId, owner), []);

    assert.equal(await store.deleteSession(sessionId, otherOwner), false);
    assert.equal(await store.deleteSession(sessionId, owner), true);
    assert.equal(await store.getSession(sessionId, owner), undefined);
    assert.deepEqual(await store.getLoadedAgentFiles(sessionId, owner), []);
  } finally {
    await automationStore?.close();
    await store?.close();
    await adminPool.query(`drop schema if exists ${quoteIdentifier(schemaName)} cascade`);
    await adminPool.end();
  }
}

async function createPgPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace-integration-test",
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
    if (message.includes("Cannot find package 'pg'") || message.includes("Cannot find module 'pg'")) {
      throw new Error(
        "Postgres integration tests require the optional pg peer dependency. Install it before running: npm install pg",
      );
    }
    throw error;
  }
}

function withSearchPath(databaseUrl: string, schemaName: string): string {
  const parsed = new URL(databaseUrl);
  const existingOptions = parsed.searchParams.get("options")?.trim();
  const searchPathOption = `-c search_path=${schemaName}`;
  parsed.searchParams.set(
    "options",
    existingOptions ? `${existingOptions} ${searchPathOption}` : searchPathOption,
  );
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function parsePostgresSslMode(value: string | undefined): PostgresSslMode {
  if (!value || value === "prefer") return "prefer";
  if (value === "disable" || value === "require") return value;
  throw new Error(`Invalid DEVSPACE_POSTGRES_SSL_MODE: ${value}`);
}

function sslFor(config: PostgresDatabaseConfig): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
