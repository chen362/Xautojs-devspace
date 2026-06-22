import assert from "node:assert/strict";
import { createOidcIdentity } from "./identity.js";
import {
  AutomationIdempotencyConflictError,
  PostgresAutomationStore,
  type AutomationEventStatus,
  type AutomationRunStatus,
  type AutomationSourceKind,
  type AutomationSourceStatus,
  type JsonObject,
  type PostgresAutomationQuery,
  type PostgresAutomationQueryResult,
  type PostgresAutomationQueryRunner,
} from "./postgres-automation-store.js";

interface StoredAutomationSourceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: AutomationSourceKind;
  name: string;
  status: AutomationSourceStatus;
  secret_ref: string | null;
  token_hash: string | null;
  config: JsonObject;
  created_at: string;
  updated_at: string;
}

interface StoredAutomationEventRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_id: string;
  source_event_id: string | null;
  idempotency_key: string | null;
  request_fingerprint: string;
  event_type: string;
  payload: JsonObject;
  metadata: JsonObject;
  devspace_conversation_id: string | null;
  workspace_session_id: string | null;
  status: AutomationEventStatus;
  received_at: string;
}

interface StoredAutomationRunRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_id: string;
  status: AutomationRunStatus;
  workspace_session_id: string | null;
  devspace_conversation_id: string | null;
  attempt: number;
  metadata: JsonObject;
  result: JsonObject;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const sourceRows: StoredAutomationSourceRow[] = [];
const eventRows: StoredAutomationEventRow[] = [];
const runRows: StoredAutomationRunRow[] = [];
const calls: PostgresAutomationQuery[] = [];

const runner: PostgresAutomationQueryRunner = async <Row>(
  query: PostgresAutomationQuery,
): Promise<PostgresAutomationQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("insert into automation_sources")) {
    const row: StoredAutomationSourceRow = {
      id: stringValue(query.values[0]),
      tenant_id: stringValue(query.values[1]),
      user_id: stringValue(query.values[2]),
      kind: sourceKindValue(query.values[3]),
      name: stringValue(query.values[4]),
      status: sourceStatusValue(query.values[5]),
      secret_ref: nullableStringValue(query.values[6]),
      token_hash: nullableStringValue(query.values[7]),
      config: jsonValue(query.values[8]),
      created_at: stringValue(query.values[9]),
      updated_at: stringValue(query.values[10]),
    };
    sourceRows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from automation_sources")) {
    const matches = normalizedSql.includes("token_hash = $2")
      ? sourceRows.filter(
          (row) =>
            row.id === query.values[0] &&
            row.token_hash === query.values[1] &&
            row.kind === "api_trigger",
        )
      : sourceRows.filter(
          (row) =>
            row.id === query.values[0] &&
            row.tenant_id === query.values[1] &&
            row.user_id === query.values[2],
        );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from automation_events") && normalizedSql.includes("where source_id")) {
    const sourceId = stringValue(query.values[0]);
    const sourceEventId = nullableStringValue(query.values[1]);
    const idempotencyKey = nullableStringValue(query.values[2]);
    const tenantId = stringValue(query.values[3]);
    const userId = stringValue(query.values[4]);
    const matches = eventRows.filter(
      (row) =>
        row.source_id === sourceId &&
        row.tenant_id === tenantId &&
        row.user_id === userId &&
        ((sourceEventId !== null && row.source_event_id === sourceEventId) ||
          (idempotencyKey !== null && row.idempotency_key === idempotencyKey)),
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("insert into automation_events")) {
    const source = sourceRows.find(
      (row) =>
        row.id === query.values[2] &&
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1],
    );
    if (!source) return { rows: [], rowCount: 0 };

    const row: StoredAutomationEventRow = {
      id: stringValue(query.values[3]),
      tenant_id: source.tenant_id,
      user_id: source.user_id,
      source_id: source.id,
      source_event_id: nullableStringValue(query.values[4]),
      idempotency_key: nullableStringValue(query.values[5]),
      request_fingerprint: stringValue(query.values[6]),
      event_type: stringValue(query.values[7]),
      payload: jsonValue(query.values[8]),
      metadata: jsonValue(query.values[9]),
      devspace_conversation_id: nullableStringValue(query.values[10]),
      workspace_session_id: nullableStringValue(query.values[11]),
      status: eventStatusValue(query.values[12]),
      received_at: stringValue(query.values[13]),
    };
    eventRows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from automation_events")) {
    const matches = eventRows.filter(
      (row) =>
        row.id === query.values[0] &&
        row.tenant_id === query.values[1] &&
        row.user_id === query.values[2],
    );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  if (normalizedSql.startsWith("insert into automation_runs")) {
    const event = eventRows.find(
      (row) =>
        row.id === query.values[2] &&
        row.tenant_id === query.values[0] &&
        row.user_id === query.values[1],
    );
    if (!event) return { rows: [], rowCount: 0 };

    const row: StoredAutomationRunRow = {
      id: stringValue(query.values[3]),
      tenant_id: event.tenant_id,
      user_id: event.user_id,
      event_id: event.id,
      status: runStatusValue(query.values[4]),
      workspace_session_id: nullableStringValue(query.values[5]),
      devspace_conversation_id: nullableStringValue(query.values[6]),
      attempt: numberValue(query.values[7]),
      metadata: jsonValue(query.values[8]),
      result: jsonValue(query.values[9]),
      error_code: nullableStringValue(query.values[10]),
      error_message: nullableStringValue(query.values[11]),
      created_at: stringValue(query.values[12]),
      started_at: nullableStringValue(query.values[13]),
      finished_at: nullableStringValue(query.values[14]),
    };
    runRows.push(row);
    return { rows: [row as Row], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select") && normalizedSql.includes("from automation_runs")) {
    const matches = normalizedSql.includes("where event_id")
      ? runRows.filter(
          (row) =>
            row.event_id === query.values[0] &&
            row.tenant_id === query.values[1] &&
            row.user_id === query.values[2],
        )
      : runRows.filter(
          (row) =>
            row.id === query.values[0] &&
            row.tenant_id === query.values[1] &&
            row.user_id === query.values[2],
        );
    return { rows: matches as Row[], rowCount: matches.length };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresAutomationStore(
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

const source = await store.createSource({
  owner: alice,
  id: "auto_src_1",
  kind: "api_trigger",
  name: "manual smoke",
  secretRef: "secret:automation/manual-smoke",
  tokenHash: "sha256:source-token",
  config: { triggerId: "manual-smoke" },
});
assert.equal(source.id, "auto_src_1");
assert.equal(source.tenantId, alice.tenantId);
assert.equal(source.userId, alice.userId);
assert.equal(source.kind, "api_trigger");
assert.equal(source.status, "enabled");
assert.equal(source.tokenHash, "sha256:source-token");
assert.deepEqual(source.config, { triggerId: "manual-smoke" });
assert.match(calls[0]?.text ?? "", /insert into automation_sources/i);
assert.equal(calls[0]?.text.includes("auto_src_1"), false);

const loadedSource = await store.getSource("auto_src_1", alice);
assert.equal(loadedSource?.id, "auto_src_1");
assert.equal(await store.getSource("auto_src_1", bob), undefined);
assert.equal(
  (await store.getApiTriggerSourceForToken({
    triggerId: "auto_src_1",
    tokenHash: "sha256:source-token",
  }))?.id,
  "auto_src_1",
);
assert.equal(
  await store.getApiTriggerSourceForToken({
    triggerId: "auto_src_1",
    tokenHash: "sha256:wrong-token",
  }),
  undefined,
);

const recorded = await store.recordEvent({
  owner: alice,
  id: "auto_evt_1",
  sourceId: "auto_src_1",
  sourceEventId: "provider_evt_1",
  idempotencyKey: "idem_1",
  requestFingerprint: "sha256:event-1",
  eventType: "automation.trigger.fire",
  payload: { text: "run smoke" },
  metadata: { method: "POST" },
  devspaceConversationId: "conv_1",
  workspaceSessionId: "ws_1",
});
assert.equal(recorded.outcome, "inserted");
assert.equal(recorded.event.id, "auto_evt_1");
assert.deepEqual(recorded.event.payload, { text: "run smoke" });
assert.deepEqual(recorded.event.metadata, { method: "POST" });

const duplicate = await store.recordEvent({
  owner: alice,
  id: "auto_evt_duplicate",
  sourceId: "auto_src_1",
  sourceEventId: "provider_evt_1",
  idempotencyKey: "idem_1",
  requestFingerprint: "sha256:event-1",
  eventType: "automation.trigger.fire",
  payload: { text: "run smoke" },
});
assert.equal(duplicate.outcome, "duplicate");
assert.equal(duplicate.event.id, "auto_evt_1");
assert.equal(eventRows.length, 1);

await assert.rejects(
  () =>
    store.recordEvent({
      owner: alice,
      id: "auto_evt_conflict",
      sourceId: "auto_src_1",
      idempotencyKey: "idem_1",
      requestFingerprint: "sha256:changed",
      eventType: "automation.trigger.fire",
    }),
  AutomationIdempotencyConflictError,
);

assert.equal(await store.getEvent("auto_evt_1", bob), undefined);
assert.equal((await store.getEvent("auto_evt_1", alice))?.id, "auto_evt_1");

const run = await store.createRun({
  owner: alice,
  id: "auto_run_1",
  eventId: "auto_evt_1",
  status: "queued",
  workspaceSessionId: "ws_1",
  devspaceConversationId: "conv_1",
  metadata: { queue: "default" },
});
assert.equal(run.id, "auto_run_1");
assert.equal(run.eventId, "auto_evt_1");
assert.equal(run.status, "queued");
assert.equal(run.attempt, 1);
assert.deepEqual(run.metadata, { queue: "default" });

assert.equal(await store.getRun("auto_run_1", bob), undefined);
assert.equal((await store.getRun("auto_run_1", alice))?.id, "auto_run_1");
assert.equal((await store.getRunForEvent("auto_evt_1", alice))?.id, "auto_run_1");
assert.equal(await store.getRunForEvent("auto_evt_1", bob), undefined);

await assert.rejects(
  () =>
    store.createRun({
      owner: bob,
      id: "auto_run_bob",
      eventId: "auto_evt_1",
    }),
  /AUTOMATION_EVENT_NOT_FOUND/,
);

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

function jsonValue(value: unknown): JsonObject {
  if (typeof value === "string") return JSON.parse(value) as JsonObject;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function sourceKindValue(value: unknown): AutomationSourceKind {
  if (value === "api_trigger" || value === "github_webhook" || value === "runtime_hook") return value;
  throw new Error(`Expected automation source kind: ${String(value)}`);
}

function sourceStatusValue(value: unknown): AutomationSourceStatus {
  if (value === "enabled" || value === "disabled") return value;
  throw new Error(`Expected automation source status: ${String(value)}`);
}

function eventStatusValue(value: unknown): AutomationEventStatus {
  if (value === "accepted" || value === "rejected") return value;
  throw new Error(`Expected automation event status: ${String(value)}`);
}

function runStatusValue(value: unknown): AutomationRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`Expected automation run status: ${String(value)}`);
}
