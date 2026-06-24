import assert from "node:assert/strict";
import type { WorkspaceIdentity } from "./identity.js";
import {
  PostgresCloudDeviceConnectionStore,
  type PostgresCloudDeviceConnectionQuery,
  type PostgresCloudDeviceConnectionQueryResult,
  type PostgresCloudDeviceConnectionQueryRunner,
} from "./postgres-cloud-device-connection-store.js";

interface StoredConnectionRow {
  tenant_id: string;
  user_id: string;
  device_id: string;
  connection_id: string;
  status: string;
  capabilities: unknown;
  desktop_instance_id: string | null;
  agent_version: string | null;
  connected_at: string;
  last_heartbeat_at: string;
  disconnected_at: string | null;
}

const owner: WorkspaceIdentity = { tenantId: "tenant_conn_pg", userId: "user_conn_pg" };
const otherOwner: WorkspaceIdentity = { tenantId: "tenant_conn_pg", userId: "user_conn_pg_other" };
const rows: StoredConnectionRow[] = [];
const calls: PostgresCloudDeviceConnectionQuery[] = [];

const runner: PostgresCloudDeviceConnectionQueryRunner = async <Row>(
  query: PostgresCloudDeviceConnectionQuery,
): Promise<PostgresCloudDeviceConnectionQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into cloud_device_connections")) {
    const next: StoredConnectionRow = {
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      device_id: stringValue(query.values[2]),
      connection_id: stringValue(query.values[3]),
      status: "online",
      capabilities: parseCapabilities(query.values[4]),
      desktop_instance_id: nullableStringValue(query.values[5]),
      agent_version: nullableStringValue(query.values[6]),
      connected_at: stringValue(query.values[7]),
      last_heartbeat_at: stringValue(query.values[8]),
      disconnected_at: null,
    };
    const index = rows.findIndex((candidate) => sameDevice(candidate, next));
    if (index >= 0) {
      const existing = rows[index];
      if (!existing) throw new Error("Missing device connection row");
      rows[index] = { ...next, connected_at: existing.connected_at };
    } else {
      rows.push(next);
    }
    return { rows: [rows.find((candidate) => sameDevice(candidate, next)) as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_device_connections") && normalizedSql.includes("set status = 'online'")) {
    const row = findConnection(query);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = "online";
    row.last_heartbeat_at = stringValue(query.values[4]);
    row.disconnected_at = null;
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("update cloud_device_connections") && normalizedSql.includes("set status = 'offline'")) {
    const row = findConnection(query);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = "offline";
    row.last_heartbeat_at = stringValue(query.values[4]);
    row.disconnected_at = stringValue(query.values[5]);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("limit 1")) {
    const matches = rows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.device_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("order by last_heartbeat_at desc")) {
    const status = nullableStringValue(query.values[2]);
    const matches = rows
      .filter(
        (row) =>
          row.tenant_id === query.values[0] &&
          row.user_id === query.values[1] &&
          (status === null || row.status === status),
      )
      .sort((left, right) => right.last_heartbeat_at.localeCompare(left.last_heartbeat_at));
    return { rows: matches as Row[], rowCount: matches.length };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresCloudDeviceConnectionStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);

const connected = await store.recordConnected({
  owner,
  deviceId: "dev_conn_pg_a",
  connectionId: "conn_pg_a",
  capabilities: ["shell", "mcp-tools", "shell"],
  desktopInstanceId: "desk_pg_a",
  agentVersion: "1.2.3",
  now: "2026-06-24T00:00:00.000Z",
});
assert.equal(connected.status, "online");
assert.deepEqual(connected.capabilities, ["mcp-tools", "shell"]);
assert.match(calls.at(-1)?.text ?? "", /insert into cloud_device_connections/i);
assert.equal(calls.at(-1)?.text.includes("dev_conn_pg_a"), false);

const heartbeated = await store.recordHeartbeat({
  owner,
  deviceId: "dev_conn_pg_a",
  connectionId: "conn_pg_a",
  now: "2026-06-24T00:00:05.000Z",
});
assert.equal(heartbeated?.status, "online");
assert.equal(heartbeated?.lastHeartbeatAt, "2026-06-24T00:00:05.000Z");

await store.recordConnected({
  owner: otherOwner,
  deviceId: "dev_conn_pg_a",
  connectionId: "conn_pg_other",
  capabilities: ["mcp-tools"],
  now: "2026-06-24T00:00:06.000Z",
});
const ownerDevices = await store.listConnections({ owner });
assert.equal(ownerDevices.length, 1);
assert.equal(ownerDevices[0]?.connectionId, "conn_pg_a");

const onlineDevices = await store.listConnections({ owner, status: "online" });
assert.equal(onlineDevices.length, 1);
assert.equal(onlineDevices[0]?.lastHeartbeatAt, "2026-06-24T00:00:05.000Z");

const disconnected = await store.recordDisconnected({
  owner,
  deviceId: "dev_conn_pg_a",
  connectionId: "conn_pg_a",
  now: "2026-06-24T00:00:10.000Z",
});
assert.equal(disconnected?.status, "offline");
assert.equal(disconnected?.disconnectedAt, "2026-06-24T00:00:10.000Z");

const fetched = await store.getConnection(owner, "dev_conn_pg_a");
assert.equal(fetched?.status, "offline");
assert.deepEqual(await store.listConnections({ owner, status: "online" }), []);

function sameDevice(left: StoredConnectionRow, right: StoredConnectionRow): boolean {
  return left.tenant_id === right.tenant_id && left.user_id === right.user_id && left.device_id === right.device_id;
}

function findConnection(query: PostgresCloudDeviceConnectionQuery): StoredConnectionRow | undefined {
  return rows.find(
    (row) =>
      row.tenant_id === query.values[0] &&
      row.user_id === query.values[1] &&
      row.device_id === query.values[2] &&
      row.connection_id === query.values[3],
  );
}

function parseCapabilities(value: unknown): string[] {
  const parsed = JSON.parse(stringValue(value)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected capabilities array");
  return parsed.filter((item): item is string => typeof item === "string");
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}
