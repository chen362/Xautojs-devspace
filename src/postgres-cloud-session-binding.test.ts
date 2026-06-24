import assert from "node:assert/strict";
import {
  CloudRoutingError,
  type CloudRoutingErrorCode,
} from "./cloud-routing-contract.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  PostgresCloudSessionBindingService,
  type PostgresCloudSessionBindingQuery,
  type PostgresCloudSessionBindingQueryResult,
  type PostgresCloudSessionBindingQueryRunner,
} from "./postgres-cloud-session-binding.js";

interface StoredBindingRow {
  tenant_id: string;
  user_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  device_id: string;
  bound_at: string;
  last_seen_at: string;
  expires_at: string | null;
}

const owner: WorkspaceIdentity = { tenantId: "tenant_bind_pg", userId: "user_bind_pg" };
const rows: StoredBindingRow[] = [];
const calls: PostgresCloudSessionBindingQuery[] = [];
const routingStore = new InMemoryCloudRoutingStore();

const runner: PostgresCloudSessionBindingQueryRunner = async <Row>(
  query: PostgresCloudSessionBindingQuery,
): Promise<PostgresCloudSessionBindingQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("select")) {
    const matches = rows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.mcp_session_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("insert into cloud_session_bindings")) {
    const row: StoredBindingRow = {
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      mcp_session_id: stringValue(query.values[2]),
      conversation_session_id: nullableStringValue(query.values[3]),
      device_id: stringValue(query.values[4]),
      bound_at: stringValue(query.values[5]),
      last_seen_at: stringValue(query.values[6]),
      expires_at: nullableStringValue(query.values[7]),
    };
    const index = rows.findIndex((candidate) => sameBinding(candidate, row));
    if (index >= 0) {
      const existing = rows[index];
      if (!existing) throw new Error("Missing binding row");
      rows[index] = { ...row, bound_at: existing.bound_at };
    } else {
      rows.push(row);
    }
    return { rows: [rows.find((candidate) => sameBinding(candidate, row)) as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_session_bindings")) {
    const row = rows.find(
      (candidate) =>
        candidate.tenant_id === query.values[0] &&
        candidate.user_id === query.values[1] &&
        candidate.mcp_session_id === query.values[2],
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.last_seen_at = stringValue(query.values[3]);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("delete from cloud_session_bindings")) {
    const index = rows.findIndex(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.mcp_session_id === query.values[2],
    );
    if (index >= 0) rows.splice(index, 1);
    return { rows: [], rowCount: index >= 0 ? 1 : 0 };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const service = new PostgresCloudSessionBindingService(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  routingStore,
  runner,
);

await routingStore.registerDevice({
  owner,
  deviceId: "dev_bind_pg_a",
  capabilities: ["mcp-tools"],
  now: "2026-06-24T00:00:00.000Z",
});

const binding = await service.bindDevice({
  owner,
  mcpSessionId: "mcp_bind_pg_a",
  conversationSessionId: "conv_bind_pg_a",
  deviceId: "dev_bind_pg_a",
  now: "2026-06-24T00:00:01.000Z",
});
assert.equal(binding.deviceId, "dev_bind_pg_a");
assert.match(calls.at(-1)?.text ?? "", /insert into cloud_session_bindings/i);
assert.equal(calls.at(-1)?.text.includes("dev_bind_pg_a"), false);

const resolved = await service.resolveDevice({
  owner,
  mcpSessionId: "mcp_bind_pg_a",
  conversationSessionId: "conv_bind_pg_a",
  now: "2026-06-24T00:00:02.000Z",
});
assert.equal(resolved.lastSeenAt, "2026-06-24T00:00:02.000Z");

await assertRoutingError(
  () => service.resolveDevice({
    owner,
    mcpSessionId: "mcp_bind_pg_a",
    conversationSessionId: "conv_bind_pg_b",
  }),
  "WORKSPACE_FORBIDDEN",
);

await routingStore.registerDevice({ owner, deviceId: "dev_bind_pg_b" });
await assertRoutingError(
  () => service.resolveDevice({
    owner,
    mcpSessionId: "mcp_bind_pg_a",
    conversationSessionId: "conv_bind_pg_a",
    deviceId: "dev_bind_pg_b",
  }),
  "DEVICE_FORBIDDEN",
);

await routingStore.setDeviceStatus({ owner, deviceId: "dev_bind_pg_a", status: "offline" });
await assertRoutingError(
  () => service.resolveDevice({
    owner,
    mcpSessionId: "mcp_bind_pg_a",
    conversationSessionId: "conv_bind_pg_a",
  }),
  "DEVICE_OFFLINE",
  true,
);

await routingStore.registerDevice({ owner, deviceId: "dev_bind_pg_expiring" });
await service.bindDevice({
  owner,
  mcpSessionId: "mcp_bind_pg_expiring",
  conversationSessionId: "conv_bind_pg_expiring",
  deviceId: "dev_bind_pg_expiring",
  now: "2026-06-24T00:00:03.000Z",
  expiresAt: "2026-06-24T00:00:04.000Z",
});
await assertRoutingError(
  () => service.resolveDevice({
    owner,
    mcpSessionId: "mcp_bind_pg_expiring",
    conversationSessionId: "conv_bind_pg_expiring",
    now: "2026-06-24T00:00:05.000Z",
  }),
  "SESSION_EXPIRED",
);
assert.equal(rows.some((row) => row.mcp_session_id === "mcp_bind_pg_expiring"), false);

function sameBinding(left: StoredBindingRow, right: StoredBindingRow): boolean {
  return (
    left.tenant_id === right.tenant_id &&
    left.user_id === right.user_id &&
    left.mcp_session_id === right.mcp_session_id
  );
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}

async function assertRoutingError(
  action: () => Promise<unknown>,
  code: CloudRoutingErrorCode,
  retryable = false,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof CloudRoutingError &&
      error.code === code &&
      error.retryable === retryable,
  );
}
