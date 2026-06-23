import assert from "node:assert/strict";
import {
  CloudRoutingError,
  type CloudRoutingDeviceStatus,
  type CloudRoutingErrorCode,
  type CloudRoutingToolCallStatus,
  type CloudRoutingWorkspaceStatus,
} from "./cloud-routing-contract.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  PostgresCloudRoutingStore,
  type PostgresCloudRoutingQuery,
  type PostgresCloudRoutingQueryResult,
  type PostgresCloudRoutingQueryRunner,
} from "./postgres-cloud-routing-store.js";

interface StoredCloudDeviceRow {
  tenant_id: string;
  user_id: string;
  device_id: string;
  label: string | null;
  capabilities: string;
  status: CloudRoutingDeviceStatus;
  registered_at: string;
  last_seen_at: string;
  expires_at: string | null;
}

interface StoredCloudWorkspaceRouteRow {
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  device_id: string;
  workspace_ref: string | null;
  status: CloudRoutingWorkspaceStatus;
  created_at: string;
  last_routed_at: string | null;
  expires_at: string | null;
}

interface StoredCloudToolCallRow {
  tenant_id: string;
  user_id: string;
  tool_call_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  workspace_id: string;
  device_id: string;
  tool_name: string | null;
  status: CloudRoutingToolCallStatus;
  created_at: string;
  last_seen_at: string;
  deadline_at: string | null;
  completed_at: string | null;
}

const owner: WorkspaceIdentity = { tenantId: "tenant_pg", userId: "user_pg" };
const otherOwner: WorkspaceIdentity = { tenantId: "tenant_pg", userId: "user_other" };
const deviceRows: StoredCloudDeviceRow[] = [];
const workspaceRows: StoredCloudWorkspaceRouteRow[] = [];
const toolCallRows: StoredCloudToolCallRow[] = [];
const calls: PostgresCloudRoutingQuery[] = [];

const runner: PostgresCloudRoutingQueryRunner = async <Row>(
  query: PostgresCloudRoutingQuery,
): Promise<PostgresCloudRoutingQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into cloud_devices")) {
    const row: StoredCloudDeviceRow = {
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      device_id: stringValue(query.values[2]),
      label: nullableStringValue(query.values[3]),
      capabilities: stringValue(query.values[4]),
      status: deviceStatusValue(query.values[5]),
      registered_at: stringValue(query.values[6]),
      last_seen_at: stringValue(query.values[7]),
      expires_at: nullableStringValue(query.values[8]),
    };
    const index = deviceRows.findIndex((candidate) => sameDevice(candidate, row));
    if (index >= 0) {
      const existing = deviceRows[index];
      if (!existing) throw new Error("Missing device row");
      deviceRows[index] = { ...row, registered_at: existing.registered_at };
    } else {
      deviceRows.push(row);
    }
    return { rows: [deviceRows.find((candidate) => sameDevice(candidate, row)) as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_devices")) {
    const row = deviceRows.find(
      (candidate) =>
        candidate.tenant_id === query.values[0] &&
        candidate.user_id === query.values[1] &&
        candidate.device_id === query.values[2],
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.status = deviceStatusValue(query.values[3]);
    row.last_seen_at = stringValue(query.values[4]);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from cloud_devices")) {
    const matches = deviceRows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.device_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from cloud_workspace_routes")) {
    const matches = workspaceRows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.workspace_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("insert into cloud_workspace_routes")) {
    const row: StoredCloudWorkspaceRouteRow = {
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      workspace_id: stringValue(query.values[2]),
      mcp_session_id: stringValue(query.values[3]),
      conversation_session_id: nullableStringValue(query.values[4]),
      device_id: stringValue(query.values[5]),
      workspace_ref: nullableStringValue(query.values[6]),
      status: "active",
      created_at: stringValue(query.values[7]),
      last_routed_at: null,
      expires_at: nullableStringValue(query.values[8]),
    };
    const index = workspaceRows.findIndex((candidate) => sameWorkspaceRoute(candidate, row));
    if (index >= 0) {
      const existing = workspaceRows[index];
      if (!existing) throw new Error("Missing workspace route row");
      workspaceRows[index] = { ...row, created_at: existing.created_at, last_routed_at: existing.last_routed_at };
    } else {
      workspaceRows.push(row);
    }
    return { rows: [workspaceRows.find((candidate) => sameWorkspaceRoute(candidate, row)) as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_workspace_routes")) {
    const row = workspaceRows.find(
      (candidate) =>
        candidate.tenant_id === query.values[0] &&
        candidate.user_id === query.values[1] &&
        candidate.workspace_id === query.values[2],
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.last_routed_at = stringValue(query.values[3]);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from cloud_tool_calls")) {
    const matches = toolCallRows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.tool_call_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("insert into cloud_tool_calls")) {
    const row: StoredCloudToolCallRow = {
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      tool_call_id: stringValue(query.values[2]),
      mcp_session_id: stringValue(query.values[3]),
      conversation_session_id: nullableStringValue(query.values[4]),
      workspace_id: stringValue(query.values[5]),
      device_id: stringValue(query.values[6]),
      tool_name: nullableStringValue(query.values[7]),
      status: "routed",
      created_at: stringValue(query.values[8]),
      last_seen_at: stringValue(query.values[9]),
      deadline_at: nullableStringValue(query.values[10]),
      completed_at: null,
    };
    toolCallRows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_tool_calls")) {
    const row = toolCallRows.find(
      (candidate) =>
        candidate.tenant_id === query.values[0] &&
        candidate.user_id === query.values[1] &&
        candidate.tool_call_id === query.values[2],
    );
    if (!row) return { rows: [], rowCount: 0 };
    if (normalizedSql.includes("completed_at")) {
      row.status = toolCallStatusValue(query.values[3]);
      row.last_seen_at = stringValue(query.values[4]);
      row.completed_at = stringValue(query.values[5]);
    } else {
      row.last_seen_at = stringValue(query.values[3]);
    }
    return { rows: [row as Row], rowCount: 1 };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresCloudRoutingStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);

const device = await store.registerDevice({
  owner,
  deviceId: "dev_pg_a",
  label: "Postgres Device A",
  capabilities: ["shell", "mcp-tools", "shell"],
  now: "2026-06-24T00:00:00.000Z",
});
assert.equal(device.deviceId, "dev_pg_a");
assert.deepEqual(device.capabilities, ["mcp-tools", "shell"]);
assert.match(calls[0]?.text ?? "", /insert into cloud_devices/i);
assert.equal(calls[0]?.text.includes("dev_pg_a"), false);

const route = await store.bindWorkspaceRoute({
  owner,
  deviceId: "dev_pg_a",
  workspaceId: "mcp_ws_pg_a",
  workspaceRef: "wsroot_pg_a",
  mcpSessionId: "mcp_pg_a",
  conversationSessionId: "conv_pg_a",
  now: "2026-06-24T00:00:01.000Z",
});
assert.equal(route.workspaceId, "mcp_ws_pg_a");
assert.equal(route.mcpSessionId, "mcp_pg_a");

const resolved = await store.resolveWorkspaceRoute({
  owner,
  workspaceId: "mcp_ws_pg_a",
  mcpSessionId: "mcp_pg_a",
  conversationSessionId: "conv_pg_a",
  toolCallId: "tc_pg_read",
  tool: "read_file",
  now: "2026-06-24T00:00:02.000Z",
  deadlineAt: "2026-06-24T00:01:02.000Z",
});
assert.equal(resolved.workspace.lastRoutedAt, "2026-06-24T00:00:02.000Z");
assert.equal(resolved.device.deviceId, "dev_pg_a");
assert.equal(resolved.toolCall?.toolCallId, "tc_pg_read");
assert.equal(resolved.toolCall?.status, "routed");
assert.equal(resolved.toolCall?.tool, "read_file");
assert.equal(resolved.toolCall?.deadlineAt, "2026-06-24T00:01:02.000Z");

const completed = await store.completeToolCallRoute({
  owner,
  toolCallId: "tc_pg_read",
  status: "completed",
  now: "2026-06-24T00:00:03.000Z",
});
assert.equal(completed?.status, "completed");
assert.equal(completed?.completedAt, "2026-06-24T00:00:03.000Z");

await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_pg_a",
    mcpSessionId: "mcp_pg_b",
    conversationSessionId: "conv_pg_a",
  }),
  "WORKSPACE_FORBIDDEN",
);

await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner: otherOwner,
    workspaceId: "mcp_ws_pg_a",
    mcpSessionId: "mcp_pg_a",
    conversationSessionId: "conv_pg_a",
  }),
  "WORKSPACE_NOT_FOUND",
);

await store.registerDevice({ owner, deviceId: "dev_pg_b" });
await store.bindWorkspaceRoute({
  owner,
  deviceId: "dev_pg_b",
  workspaceId: "mcp_ws_pg_b",
  mcpSessionId: "mcp_pg_a",
  conversationSessionId: "conv_pg_a",
});
await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_pg_b",
    mcpSessionId: "mcp_pg_a",
    conversationSessionId: "conv_pg_a",
    toolCallId: "tc_pg_read",
    tool: "read_file",
  }),
  "TOOL_CALL_CONFLICT",
);

await store.setDeviceStatus({ owner, deviceId: "dev_pg_a", status: "offline" });
await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_pg_a",
    mcpSessionId: "mcp_pg_a",
    conversationSessionId: "conv_pg_a",
  }),
  "DEVICE_OFFLINE",
  true,
);

function sameDevice(left: StoredCloudDeviceRow, right: StoredCloudDeviceRow): boolean {
  return left.tenant_id === right.tenant_id && left.user_id === right.user_id && left.device_id === right.device_id;
}

function sameWorkspaceRoute(left: StoredCloudWorkspaceRouteRow, right: StoredCloudWorkspaceRouteRow): boolean {
  return left.tenant_id === right.tenant_id && left.user_id === right.user_id && left.workspace_id === right.workspace_id;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}

function deviceStatusValue(value: unknown): CloudRoutingDeviceStatus {
  if (value === "online" || value === "offline" || value === "revoked") return value;
  throw new Error(`Expected cloud device status: ${String(value)}`);
}

function toolCallStatusValue(value: unknown): CloudRoutingToolCallStatus {
  if (value === "routed" || value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error(`Expected cloud tool call status: ${String(value)}`);
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
