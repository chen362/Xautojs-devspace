import assert from "node:assert/strict";
import { createOidcIdentity } from "./identity.js";
import {
  PostgresWorkspaceStore,
  type PostgresQuery,
  type PostgresQueryResult,
  type PostgresQueryRunner,
} from "./postgres-workspace-store.js";

interface StoredWorkspaceSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  root: string;
  status: string;
  mode: string;
  source_root: string | null;
  base_ref: string | null;
  base_sha: string | null;
  managed: boolean;
  created_at: string;
  last_used_at: string;
}

const rows: StoredWorkspaceSessionRow[] = [];
const calls: PostgresQuery[] = [];
const runner: PostgresQueryRunner = <Row>(_config, query): PostgresQueryResult<Row> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into workspace_sessions")) {
    rows.push({
      id: stringValue(query.values[0]),
      tenant_id: stringValue(query.values[1]),
      user_id: stringValue(query.values[2]),
      root: stringValue(query.values[3]),
      status: stringValue(query.values[4]),
      mode: stringValue(query.values[5]),
      source_root: nullableStringValue(query.values[6]),
      base_ref: nullableStringValue(query.values[7]),
      base_sha: nullableStringValue(query.values[8]),
      managed: Boolean(query.values[9]),
      created_at: stringValue(query.values[10]),
      last_used_at: stringValue(query.values[11]),
    });
    return { rows: [], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select")) {
    const matches = rows.filter(
      (row) =>
        row.id === query.values[0] &&
        row.tenant_id === query.values[1] &&
        row.user_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("update workspace_sessions")) {
    let rowCount = 0;
    for (const row of rows) {
      if (
        row.id === query.values[0] &&
        row.tenant_id === query.values[1] &&
        row.user_id === query.values[2]
      ) {
        row.last_used_at = stringValue(query.values[3]);
        rowCount += 1;
      }
    }
    return { rows: [], rowCount };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresWorkspaceStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);
const alice = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-a",
  subject: "alice",
  scopes: ["devspace"],
});
const bob = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-a",
  subject: "bob",
  scopes: ["devspace"],
});

const created = store.createSession({
  owner: alice,
  id: "ws_postgres_1",
  root: "/repo",
  mode: "worktree",
  sourceRoot: "/source",
  baseRef: "main",
  baseSha: "abc123",
  managed: true,
});

assert.equal(created.id, "ws_postgres_1");
assert.equal(created.tenantId, alice.tenantId);
assert.equal(created.userId, alice.userId);
assert.equal(created.mode, "worktree");
assert.equal(created.managed, true);
assert.match(calls[0]?.text ?? "", /insert into workspace_sessions/i);
assert.equal(calls[0]?.values[0], "ws_postgres_1");
assert.equal(calls[0]?.text.includes("ws_postgres_1"), false);

const loaded = store.getSession("ws_postgres_1", alice);
assert.equal(loaded?.id, "ws_postgres_1");
assert.equal(loaded?.sourceRoot, "/source");
assert.equal(loaded?.baseRef, "main");
assert.equal(loaded?.baseSha, "abc123");
assert.equal(loaded?.managed, true);

assert.equal(store.getSession("ws_postgres_1", bob), undefined);

store.touchSession("ws_postgres_1", bob);
assert.equal(rows[0]?.last_used_at, created.lastUsedAt);

store.touchSession("ws_postgres_1", alice);
assert.equal(rows[0]?.last_used_at, calls.at(-1)?.values[3]);

function stringValue(value: unknown): string {
  assert.equal(typeof value, "string");
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}
