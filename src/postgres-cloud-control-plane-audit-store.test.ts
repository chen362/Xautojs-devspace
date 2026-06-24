import assert from "node:assert/strict";
import { CloudRoutingError } from "./cloud-routing-contract.js";
import type {
  CloudControlPlaneAuditAction,
  CloudControlPlaneAuditStatus,
} from "./cloud-control-plane-audit.js";
import {
  PostgresCloudControlPlaneAuditStore,
  type PostgresCloudControlPlaneAuditQuery,
  type PostgresCloudControlPlaneAuditQueryResult,
  type PostgresCloudControlPlaneAuditQueryRunner,
} from "./postgres-cloud-control-plane-audit-store.js";

interface StoredAuditRow {
  event_id: string;
  tenant_id: string | null;
  user_id: string | null;
  action: CloudControlPlaneAuditAction;
  status: CloudControlPlaneAuditStatus;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  result_json: unknown;
  error_code: string | null;
  created_at: string;
}

const rows: StoredAuditRow[] = [];
const calls: PostgresCloudControlPlaneAuditQuery[] = [];

const runner: PostgresCloudControlPlaneAuditQueryRunner = async <Row>(
  query: PostgresCloudControlPlaneAuditQuery,
): Promise<PostgresCloudControlPlaneAuditQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into cloud_control_plane_audit_events")) {
    const row = rowFromValues(query.values);
    rows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("and action = $3") && normalizedSql.includes("and idempotency_key = $4")) {
    const matches = rows.filter(
      (row) =>
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1] &&
        row.action === query.values[2] &&
        row.idempotency_key === query.values[3],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from cloud_control_plane_audit_events")) {
    const [tenantId, userId] = query.values;
    const matches = rows.filter(
      (row) =>
        (tenantId === null || row.tenant_id === tenantId) &&
        (userId === null || row.user_id === userId),
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresCloudControlPlaneAuditStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);

const owner = { tenantId: "tenant_audit_pg", userId: "user_audit_pg" };
const otherOwner = { tenantId: "tenant_audit_pg", userId: "user_audit_other" };

const event = await store.recordEvent({
  owner,
  action: "device_code.create",
  status: "completed",
  result: { deviceCode: "dc_audit_pg" },
  now: "2026-06-24T00:00:00.000Z",
});
assert.match(event.eventId, /^audit_/);
assert.equal(event.createdAt, "2026-06-24T00:00:00.000Z");
assert.deepEqual(event.result, { deviceCode: "dc_audit_pg" });
assert.equal(calls[0]?.text.includes("dc_audit_pg"), false);

const idempotent = await store.recordIdempotency({
  owner,
  action: "connect_workspace",
  status: "completed",
  idempotencyKey: "idem_workspace_a",
  requestFingerprint: "fingerprint_a",
  result: { workspaceId: "cw_audit_pg" },
  now: "2026-06-24T00:00:01.000Z",
});
const replay = await store.recordIdempotency({
  owner,
  action: "connect_workspace",
  status: "completed",
  idempotencyKey: "idem_workspace_a",
  requestFingerprint: "fingerprint_a",
  result: { workspaceId: "cw_different" },
  now: "2026-06-24T00:00:02.000Z",
});
assert.equal(replay.eventId, idempotent.eventId);
assert.deepEqual(replay.result, { workspaceId: "cw_audit_pg" });

await assert.rejects(
  () => store.recordIdempotency({
    owner,
    action: "connect_workspace",
    status: "completed",
    idempotencyKey: "idem_workspace_a",
    requestFingerprint: "fingerprint_conflict",
    result: { workspaceId: "cw_conflict" },
  }),
  (error) => error instanceof CloudRoutingError && error.code === "TOOL_CALL_CONFLICT",
);

await store.recordIdempotency({
  owner: otherOwner,
  action: "connect_workspace",
  status: "completed",
  idempotencyKey: "idem_workspace_a",
  requestFingerprint: "fingerprint_other_owner",
  result: { workspaceId: "cw_other" },
});
const ownerEvents = await store.listEvents(owner);
assert.equal(ownerEvents.length, 2);
assert.equal(ownerEvents.every((ownerEvent) => ownerEvent.owner?.userId === owner.userId), true);

function rowFromValues(values: PostgresCloudControlPlaneAuditQuery["values"]): StoredAuditRow {
  return {
    event_id: stringValue(values[0]),
    tenant_id: nullableStringValue(values[1]),
    user_id: nullableStringValue(values[2]),
    action: actionValue(values[3]),
    status: statusValue(values[4]),
    idempotency_key: nullableStringValue(values[5]),
    request_fingerprint: nullableStringValue(values[6]),
    result_json: parseJsonValue(values[7]),
    error_code: nullableStringValue(values[8]),
    created_at: stringValue(values[9]),
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

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

function actionValue(value: unknown): CloudControlPlaneAuditAction {
  if (
    value === "device_code.create" ||
    value === "device_code.approve" ||
    value === "device_code.poll" ||
    value === "connect_desktop" ||
    value === "connect_workspace" ||
    value === "route_tool_call"
  ) return value;
  throw new Error(`Expected audit action: ${String(value)}`);
}

function statusValue(value: unknown): CloudControlPlaneAuditStatus {
  if (value === "started" || value === "completed" || value === "failed" || value === "conflict") return value;
  throw new Error(`Expected audit status: ${String(value)}`);
}
