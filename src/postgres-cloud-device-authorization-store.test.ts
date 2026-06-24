import assert from "node:assert/strict";
import type { CloudDeviceAuthorizationStatus } from "./cloud-device-code-auth.js";
import {
  PostgresCloudDeviceAuthorizationStore,
  type PostgresCloudDeviceAuthorizationQuery,
  type PostgresCloudDeviceAuthorizationQueryResult,
  type PostgresCloudDeviceAuthorizationQueryRunner,
} from "./postgres-cloud-device-authorization-store.js";

interface StoredAuthorizationRow {
  device_code: string;
  user_code: string;
  status: CloudDeviceAuthorizationStatus;
  client_name: string | null;
  device_id: string | null;
  desktop_instance_id: string | null;
  tenant_id: string | null;
  user_id: string | null;
  created_at: string;
  expires_at: string;
  interval_seconds: number;
  approved_at: string | null;
  denied_at: string | null;
  last_polled_at: string | null;
}

const rows: StoredAuthorizationRow[] = [];
const calls: PostgresCloudDeviceAuthorizationQuery[] = [];

const runner: PostgresCloudDeviceAuthorizationQueryRunner = async <Row>(
  query: PostgresCloudDeviceAuthorizationQuery,
): Promise<PostgresCloudDeviceAuthorizationQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into cloud_device_authorizations")) {
    const row = rowFromValues(query.values);
    rows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("where device_code = $1")) {
    const matches = rows.filter((row) => row.device_code === query.values[0]);
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("where user_code = $1")) {
    const matches = rows.filter((row) => row.user_code === query.values[0]);
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("update cloud_device_authorizations")) {
    const next = rowFromValues(query.values);
    const index = rows.findIndex((row) => row.device_code === next.device_code);
    if (index < 0) return { rows: [], rowCount: 0 };
    rows[index] = next;
    return { rows: [next as Row], rowCount: 1 };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresCloudDeviceAuthorizationStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);

const created = await store.create({
  deviceCode: "dc_pg_auth_a",
  userCode: "abcd-1234",
  status: "pending",
  clientName: "Xautojs Desktop",
  deviceId: "dev_pg_auth_a",
  desktopInstanceId: "desk_pg_auth_a",
  createdAt: "2026-06-24T00:00:00.000Z",
  expiresAt: "2026-06-24T00:10:00.000Z",
  intervalSeconds: 5,
});
assert.equal(created.userCode, "ABCD-1234");
assert.equal(created.status, "pending");
assert.equal(calls[0]?.text.includes("dc_pg_auth_a"), false);

const byDeviceCode = await store.getByDeviceCode("dc_pg_auth_a");
assert.equal(byDeviceCode?.deviceId, "dev_pg_auth_a");
const byUserCode = await store.getByUserCode("abcd-1234");
assert.equal(byUserCode?.deviceCode, "dc_pg_auth_a");

const approved = await store.update({
  ...created,
  status: "approved",
  owner: { tenantId: "tenant_pg_auth", userId: "user_pg_auth" },
  approvedAt: "2026-06-24T00:00:05.000Z",
  lastPolledAt: "2026-06-24T00:00:06.000Z",
});
assert.equal(approved.status, "approved");
assert.deepEqual(approved.owner, { tenantId: "tenant_pg_auth", userId: "user_pg_auth" });
assert.equal(approved.approvedAt, "2026-06-24T00:00:05.000Z");
assert.equal(approved.lastPolledAt, "2026-06-24T00:00:06.000Z");

const missing = await store.getByDeviceCode("dc_missing");
assert.equal(missing, undefined);

function rowFromValues(values: PostgresCloudDeviceAuthorizationQuery["values"]): StoredAuthorizationRow {
  return {
    device_code: stringValue(values[0]),
    user_code: stringValue(values[1]),
    status: statusValue(values[2]),
    client_name: nullableStringValue(values[3]),
    device_id: nullableStringValue(values[4]),
    desktop_instance_id: nullableStringValue(values[5]),
    tenant_id: nullableStringValue(values[6]),
    user_id: nullableStringValue(values[7]),
    created_at: stringValue(values[8]),
    expires_at: stringValue(values[9]),
    interval_seconds: numberValue(values[10]),
    approved_at: nullableStringValue(values[11]),
    denied_at: nullableStringValue(values[12]),
    last_polled_at: nullableStringValue(values[13]),
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new Error(`Expected number value: ${String(value)}`);
  return value;
}

function statusValue(value: unknown): CloudDeviceAuthorizationStatus {
  if (value === "pending" || value === "approved" || value === "denied") return value;
  throw new Error(`Expected authorization status: ${String(value)}`);
}
