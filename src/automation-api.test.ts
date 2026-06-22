import assert from "node:assert/strict";
import {
  automationSourceTokenHash,
  fireAutomationTrigger,
  type AutomationAcceptedResponse,
  type AutomationErrorResponse,
  type AutomationTriggerStore,
} from "./automation-api.js";
import { AutomationIdempotencyConflictError } from "./postgres-automation-store.js";
import type {
  AutomationEvent,
  AutomationEventRecordResult,
  AutomationRun,
  AutomationSource,
  CreateAutomationRunInput,
  RecordAutomationEventInput,
} from "./postgres-automation-store.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = {
  tenantId: "tenant-a",
  userId: "alice",
};

const baseSource: AutomationSource = {
  id: "manual-smoke",
  tenantId: owner.tenantId,
  userId: owner.userId,
  kind: "api_trigger",
  name: "Manual Smoke",
  status: "enabled",
  tokenHash: automationSourceTokenHash("source-token"),
  config: {},
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

{
  const result = await fireAutomationTrigger({
    store: undefined,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-1",
    body: { text: "run smoke" },
    requestId: "req-store",
  });
  const body = expectError(result.body);
  assert.equal(result.statusCode, 503);
  assert.equal(body.error.code, "AUTOMATION_STORE_UNAVAILABLE");
  assert.equal(body.error.retryable, true);
}

{
  const store = new FakeAutomationStore(baseSource);
  const result = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: undefined,
    idempotencyKey: "idem-1",
    body: { text: "run smoke" },
    requestId: "req-auth",
  });
  assert.equal(result.statusCode, 401);
  assert.equal(expectError(result.body).error.code, "AUTOMATION_TOKEN_INVALID");
}

{
  const store = new FakeAutomationStore(baseSource);
  const result = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: undefined,
    body: { text: "run smoke" },
    requestId: "req-idem",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(expectError(result.body).error.code, "IDEMPOTENCY_KEY_REQUIRED");
}

{
  const store = new FakeAutomationStore(baseSource);
  const result = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-1",
    body: { metadata: { source: "test" } },
    requestId: "req-body",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(expectError(result.body).error.code, "AUTOMATION_PAYLOAD_INVALID");
}

{
  const store = new FakeAutomationStore(baseSource);
  const first = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-success",
    body: {
      eventId: "provider-event-1",
      text: "run smoke",
      payload: { priority: "normal" },
      conversationKey: "conv-a",
      metadata: { source: "unit" },
    },
    requestId: "req-success-1",
  });
  const accepted = expectAccepted(first.body);
  assert.equal(first.statusCode, 202);
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.dedupeGuaranteed, true);
  assert.equal(accepted.conversationKey, "conv-a");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 1);

  const second = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-success",
    body: {
      eventId: "provider-event-1",
      text: "run smoke",
      payload: { priority: "normal" },
      conversationKey: "conv-a",
      metadata: { source: "unit" },
    },
    requestId: "req-success-2",
  });
  const duplicate = expectAccepted(second.body);
  assert.equal(second.statusCode, 202);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.automationEventId, accepted.automationEventId);
  assert.equal(duplicate.automationRunId, accepted.automationRunId);
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 1);
}

{
  const store = new FakeAutomationStore(baseSource);
  const first = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-conflict",
    body: { text: "first" },
    requestId: "req-conflict-1",
  });
  assert.equal(first.statusCode, 202);

  const second = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-conflict",
    body: { text: "changed" },
    requestId: "req-conflict-2",
  });
  const body = expectError(second.body);
  assert.equal(second.statusCode, 409);
  assert.equal(body.error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(body.error.retryable, false);
}

{
  const store = new FakeAutomationStore({
    ...baseSource,
    status: "disabled",
  });
  const result = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer source-token",
    idempotencyKey: "idem-disabled",
    body: { text: "run smoke" },
    requestId: "req-disabled",
  });
  assert.equal(result.statusCode, 403);
  assert.equal(expectError(result.body).error.code, "AUTOMATION_SOURCE_DISABLED");
}

{
  const store = new FakeAutomationStore(baseSource);
  const result = await fireAutomationTrigger({
    store,
    triggerId: "manual-smoke",
    authorization: "Bearer wrong-token",
    idempotencyKey: "idem-wrong-token",
    body: { text: "run smoke" },
    requestId: "req-wrong-token",
  });
  assert.equal(result.statusCode, 401);
  assert.equal(expectError(result.body).error.code, "AUTOMATION_TOKEN_INVALID");
}

class FakeAutomationStore implements AutomationTriggerStore {
  readonly events = new Map<string, AutomationEvent>();
  readonly runs = new Map<string, AutomationRun>();

  constructor(private readonly source: AutomationSource) {}

  async getApiTriggerSourceForToken(input: {
    triggerId: string;
    tokenHash: string;
  }): Promise<AutomationSource | undefined> {
    if (input.triggerId !== this.source.id) return undefined;
    if (input.tokenHash !== this.source.tokenHash) return undefined;
    return this.source;
  }

  async recordEvent(input: RecordAutomationEventInput): Promise<AutomationEventRecordResult> {
    const existing = Array.from(this.events.values()).find(
      (event) =>
        event.sourceId === input.sourceId &&
        event.tenantId === input.owner.tenantId &&
        event.userId === input.owner.userId &&
        ((input.sourceEventId && event.sourceEventId === input.sourceEventId) ||
          (input.idempotencyKey && event.idempotencyKey === input.idempotencyKey)),
    );
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new AutomationIdempotencyConflictError(existing.id);
      }
      return { outcome: "duplicate", event: existing };
    }

    const event: AutomationEvent = {
      id: input.id,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
      sourceId: input.sourceId,
      ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      requestFingerprint: input.requestFingerprint,
      eventType: input.eventType,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      status: input.status ?? "accepted",
      receivedAt: "2026-06-22T00:00:00.000Z",
    };
    this.events.set(event.id, event);
    return { outcome: "inserted", event };
  }

  async getRunForEvent(eventId: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined> {
    return Array.from(this.runs.values()).find(
      (run) => run.eventId === eventId && run.tenantId === owner.tenantId && run.userId === owner.userId,
    );
  }

  async createRun(input: CreateAutomationRunInput): Promise<AutomationRun> {
    const run: AutomationRun = {
      id: input.id,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
      eventId: input.eventId,
      status: input.status ?? "queued",
      attempt: input.attempt ?? 1,
      metadata: input.metadata ?? {},
      result: input.result ?? {},
      createdAt: "2026-06-22T00:00:01.000Z",
    };
    this.runs.set(run.id, run);
    return run;
  }
}

function expectAccepted(body: AutomationAcceptedResponse | AutomationErrorResponse): AutomationAcceptedResponse {
  assert.ok(!("error" in body));
  return body;
}

function expectError(body: AutomationAcceptedResponse | AutomationErrorResponse): AutomationErrorResponse {
  assert.ok("error" in body);
  return body;
}
