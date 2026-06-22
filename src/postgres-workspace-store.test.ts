import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

interface StoredLoadedAgentFileRow {
  workspace_session_id: string;
  path: string;
  content_hash: string;
  content: string;
  loaded_at: string;
  last_seen_at: string;
}

const rows: StoredWorkspaceSessionRow[] = [];
const agentFileRows: StoredLoadedAgentFileRow[] = [];
const calls: PostgresQuery[] = [];
const runner: PostgresQueryRunner = async <Row>(
  query: PostgresQuery,
): Promise<PostgresQueryResult<Row>> => {
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

  if (normalizedSql.startsWith("delete from loaded_agent_files")) {
    const ownsSession = sessionMatchesOwner(
      stringValue(query.values[0]),
      stringValue(query.values[1]),
      stringValue(query.values[2]),
    );
    if (!ownsSession) return { rows: [], rowCount: 0 };

    let rowCount = 0;
    for (let index = agentFileRows.length - 1; index >= 0; index -= 1) {
      if (agentFileRows[index]?.workspace_session_id === query.values[0]) {
        agentFileRows.splice(index, 1);
        rowCount += 1;
      }
    }
    return { rows: [], rowCount };
  }

  if (normalizedSql.startsWith("insert into loaded_agent_files")) {
    const workspaceSessionId = stringValue(query.values[0]);
    if (!sessionMatchesOwner(workspaceSessionId, stringValue(query.values[1]), stringValue(query.values[2]))) {
      return { rows: [], rowCount: 0 };
    }

    const nextRow: StoredLoadedAgentFileRow = {
      workspace_session_id: workspaceSessionId,
      path: stringValue(query.values[3]),
      content_hash: stringValue(query.values[4]),
      content: stringValue(query.values[5]),
      loaded_at: stringValue(query.values[6]),
      last_seen_at: stringValue(query.values[7]),
    };
    const existingIndex = agentFileRows.findIndex(
      (row) => row.workspace_session_id === nextRow.workspace_session_id && row.path === nextRow.path,
    );
    if (existingIndex >= 0) agentFileRows[existingIndex] = nextRow;
    else agentFileRows.push(nextRow);
    return { rows: [], rowCount: 1 };
  }

  if (normalizedSql.includes("from loaded_agent_files")) {
    const matches = agentFileRows
      .filter(
        (row) =>
          row.workspace_session_id === query.values[0] &&
          sessionMatchesOwner(row.workspace_session_id, stringValue(query.values[1]), stringValue(query.values[2])),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
    return { rows: matches as Row[], rowCount: matches.length };
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

const created = await store.createSession({
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

const loaded = await store.getSession("ws_postgres_1", alice);
assert.equal(loaded?.id, "ws_postgres_1");
assert.equal(loaded?.sourceRoot, "/source");
assert.equal(loaded?.baseRef, "main");
assert.equal(loaded?.baseSha, "abc123");
assert.equal(loaded?.managed, true);

assert.equal(await store.getSession("ws_postgres_1", bob), undefined);

await store.saveLoadedAgentFiles({
  owner: alice,
  workspaceSessionId: "ws_postgres_1",
  files: [
    { path: "/repo/AGENTS.md", content: "root instructions
" },
    { path: "/repo/nested/AGENTS.md", content: "nested instructions
" },
  ],
});
const loadedAgentFiles = await store.getLoadedAgentFiles("ws_postgres_1", alice);
assert.deepEqual(
  loadedAgentFiles.map((file) => ({ path: file.path, content: file.content })),
  [
    { path: "/repo/AGENTS.md", content: "root instructions
" },
    { path: "/repo/nested/AGENTS.md", content: "nested instructions
" },
  ],
);
assert.equal(loadedAgentFiles[0]?.contentHash, hashContent("root instructions
"));
assert.match(loadedAgentFiles[0]?.loadedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
assert.deepEqual(await store.getLoadedAgentFiles("ws_postgres_1", bob), []);

await store.saveLoadedAgentFiles({
  owner: bob,
  workspaceSessionId: "ws_postgres_1",
  files: [{ path: "/repo/BOB.md", content: "bob instructions
" }],
});
assert.equal(agentFileRows.length, 2);

await store.touchSession("ws_postgres_1", bob);
assert.equal(rows[0]?.last_used_at, created.lastUsedAt);

await store.touchSession("ws_postgres_1", alice);
const lastTouchValue = calls.at(-1)?.values[3];
assert.equal(typeof lastTouchValue, "string");
assert.equal(rows[0]?.last_used_at, lastTouchValue);

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null) return null;
  return stringValue(value);
}

function sessionMatchesOwner(id: string, tenantId: string, userId: string): boolean {
  return rows.some((row) => row.id === id && row.tenant_id === tenantId && row.user_id === userId);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
