import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleGithubWebhook,
  type GithubWebhookAcceptedResponse,
  type GithubWebhookErrorResponse,
  type GithubWebhookIgnoredResponse,
  type GithubWebhookResponse,
  type GithubWebhookStore,
} from "./github-webhook-api.js";
import { AutomationIdempotencyConflictError } from "./postgres-automation-store.js";
import type {
  AutomationEvent,
  AutomationEventRecordResult,
  AutomationRun,
  AutomationSource,
  CreateAutomationRunInput,
  JsonObject,
  RecordAutomationEventInput,
} from "./postgres-automation-store.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = {
  tenantId: "tenant-a",
  userId: "alice",
};

const source: AutomationSource = {
  id: "github-main",
  tenantId: owner.tenantId,
  userId: owner.userId,
  kind: "github_webhook",
  name: "GitHub main",
  status: "enabled",
  secretRef: "env:DEVSPACE_TEST_GITHUB_WEBHOOK_SECRET",
  tokenHash: "sha256:stored-token-hash",
  config: { repository: "chen362/Xautojs-devspace" },
  createdAt: "2026-06-22T00:00:00.000Z",
  updatedAt: "2026-06-22T00:00:00.000Z",
};

class FakeGithubWebhookStore implements GithubWebhookStore {
  readonly events = new Map<string, AutomationEvent>();
  readonly runs = new Map<string, AutomationRun>();

  constructor(private readonly source: AutomationSource | undefined) {}

  async getGithubWebhookSource(id: string): Promise<AutomationSource | undefined> {
    if (id !== this.source?.id) return undefined;
    if (this.source.kind !== "github_webhook") return undefined;
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

process.env.DEVSPACE_TEST_GITHUB_WEBHOOK_SECRET = "github-webhook-secret";

{
  const result = await handleGithubWebhook({
    store: undefined,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-1",
    githubSignature256: sign(payloadBuffer({ action: "opened" })),
    rawBody: payloadBuffer({ action: "opened" }),
    requestId: "req-store",
  });
  assert.equal(result.statusCode, 503);
  assert.equal(expectError(result.body).error.code, "AUTOMATION_STORE_UNAVAILABLE");
}

{
  const store = new FakeGithubWebhookStore(source);
  const body = payloadBuffer({ action: "opened" });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-2",
    githubSignature256: sign(body, "wrong-secret"),
    rawBody: body,
    requestId: "req-signature",
  });
  assert.equal(result.statusCode, 401);
  assert.equal(expectError(result.body).error.code, "GITHUB_WEBHOOK_SIGNATURE_INVALID");
  assert.equal(store.events.size, 0);
}

{
  const store = new FakeGithubWebhookStore(source);
  const body = payloadBuffer({ action: "opened" });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: undefined,
    githubDelivery: "delivery-3",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-event",
  });
  assert.equal(result.statusCode, 400);
  assert.equal(expectError(result.body).error.code, "GITHUB_WEBHOOK_EVENT_INVALID");
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    status: "disabled",
  });
  const body = payloadBuffer({ action: "opened" });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-4",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-disabled",
  });
  assert.equal(result.statusCode, 403);
  assert.equal(expectError(result.body).error.code, "GITHUB_WEBHOOK_SOURCE_DISABLED");
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    secretRef: "secret:github/main",
  });
  const body = payloadBuffer({ action: "opened" });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-5",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-secret",
  });
  assert.equal(result.statusCode, 503);
  assert.equal(expectError(result.body).error.code, "GITHUB_WEBHOOK_SECRET_UNAVAILABLE");
}

{
  const store = new FakeGithubWebhookStore(source);
  const body = payloadBuffer({
    action: "opened",
    repository: { full_name: "chen362/Xautojs-devspace" },
    pull_request: { base: { ref: "main" } },
    sender: { login: "chen362" },
  });
  const first = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-success",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-success-1",
  });
  const accepted = expectAccepted(first.body);
  assert.equal(first.statusCode, 202);
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.githubEvent, "pull_request");
  assert.equal(accepted.githubDelivery, "delivery-success");
  assert.equal(accepted.routing.decision, "queued");
  assert.equal(accepted.routing.eventType, "github.pull_request.opened");
  assert.equal(accepted.routing.repository, "chen362/Xautojs-devspace");
  assert.equal(accepted.routing.branch, "main");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 1);

  const event = Array.from(store.events.values())[0];
  assert.equal(event?.sourceEventId, "delivery-success");
  assert.equal(event?.idempotencyKey, "github:delivery-success");
  assert.equal(event?.eventType, "github.pull_request.opened");
  assert.equal(event?.status, "accepted");
  assert.equal(event?.metadata.repository, "chen362/Xautojs-devspace");
  assert.equal(event?.metadata.sender, "chen362");
  assert.equal(event?.metadata.branch, "main");
  assert.equal(event?.metadata.routingDecision, "queued");

  const run = Array.from(store.runs.values())[0];
  assert.equal(run?.metadata.eventType, "github.pull_request.opened");
  assert.equal(run?.metadata.repository, "chen362/Xautojs-devspace");
  assert.equal(run?.metadata.branch, "main");

  const second = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-success",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-success-2",
  });
  const duplicate = expectAccepted(second.body);
  assert.equal(second.statusCode, 202);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.automationEventId, accepted.automationEventId);
  assert.equal(duplicate.automationRunId, accepted.automationRunId);
  assert.equal(duplicate.routing.decision, "queued");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 1);
}

{
  const store = new FakeGithubWebhookStore(source);
  const body = payloadBuffer({
    action: "edited",
    repository: { full_name: "chen362/Xautojs-devspace" },
    pull_request: { base: { ref: "main" } },
  });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-ignored-action",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-ignored-action",
  });
  const ignored = expectIgnored(result.body);
  assert.equal(result.statusCode, 202);
  assert.equal(ignored.status, "ignored");
  assert.equal(ignored.duplicate, false);
  assert.equal(ignored.routing.reason, "event_not_routable");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 0);
  const event = Array.from(store.events.values())[0];
  assert.equal(event?.status, "rejected");
  assert.equal(event?.metadata.routingDecision, "ignored");
  assert.equal(event?.metadata.routingReason, "event_not_routable");

  const duplicateResult = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-ignored-action",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-ignored-action-duplicate",
  });
  const duplicate = expectIgnored(duplicateResult.body);
  assert.equal(duplicateResult.statusCode, 202);
  assert.equal(duplicate.status, "ignored");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.automationEventId, ignored.automationEventId);
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 0);
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    config: {
      events: { pull_request: ["synchronize"], release: ["published"] },
      repositories: ["chen362/Xautojs-devspace"],
      branches: ["main"],
    },
  });
  const body = payloadBuffer({
    action: "synchronize",
    repository: { full_name: "chen362/Xautojs-devspace" },
    pull_request: { base: { ref: "main" } },
  });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-policy-queued",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-policy-queued",
  });
  const accepted = expectAccepted(result.body);
  assert.equal(result.statusCode, 202);
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.routing.repository, "chen362/Xautojs-devspace");
  assert.equal(accepted.routing.branch, "main");
  assert.equal(store.runs.size, 1);
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    config: {
      events: { pull_request: ["opened", "synchronize", "closed"] },
      repositories: ["chen362/Xautojs-devspace"],
      branches: ["main"],
    },
  });
  const body = payloadBuffer({
    action: "opened",
    repository: { full_name: "other/repo" },
    pull_request: { base: { ref: "main" } },
  });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-policy-repo",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-policy-repo",
  });
  const ignored = expectIgnored(result.body);
  assert.equal(result.statusCode, 202);
  assert.equal(ignored.routing.reason, "repository_not_allowed");
  assert.equal(ignored.routing.repository, "other/repo");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 0);
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    config: {
      events: { pull_request: ["opened", "synchronize", "closed"] },
      repositories: ["chen362/Xautojs-devspace"],
      branches: ["main"],
    },
  });
  const body = payloadBuffer({
    action: "opened",
    repository: { full_name: "chen362/Xautojs-devspace" },
    pull_request: { base: { ref: "feature/pr" } },
  });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-policy-branch",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-policy-branch",
  });
  const ignored = expectIgnored(result.body);
  assert.equal(result.statusCode, 202);
  assert.equal(ignored.routing.reason, "branch_not_allowed");
  assert.equal(ignored.routing.branch, "feature/pr");
  assert.equal(store.events.size, 1);
  assert.equal(store.runs.size, 0);
}

{
  const store = new FakeGithubWebhookStore(source);
  const body = payloadBuffer({
    action: "published",
    repository: { full_name: "chen362/Xautojs-devspace" },
    release: { target_commitish: "main" },
  });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "release",
    githubDelivery: "delivery-release-published",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-release-published",
  });
  const accepted = expectAccepted(result.body);
  assert.equal(result.statusCode, 202);
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.routing.eventType, "github.release.published");
  assert.equal(accepted.routing.branch, "main");
  assert.equal(store.runs.size, 1);
}

{
  const store = new FakeGithubWebhookStore({
    ...source,
    config: { events: "pull_request" as unknown as JsonObject },
  });
  const body = payloadBuffer({ action: "opened" });
  const result = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-policy-invalid",
    githubSignature256: sign(body),
    rawBody: body,
    requestId: "req-policy-invalid",
  });
  const error = expectError(result.body);
  assert.equal(result.statusCode, 500);
  assert.equal(error.error.code, "GITHUB_WEBHOOK_POLICY_INVALID");
  assert.equal(store.events.size, 0);
  assert.equal(store.runs.size, 0);
}

{
  const store = new FakeGithubWebhookStore(source);
  const firstBody = payloadBuffer({ action: "opened" });
  const first = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-conflict",
    githubSignature256: sign(firstBody),
    rawBody: firstBody,
    requestId: "req-conflict-1",
  });
  assert.equal(first.statusCode, 202);

  const secondBody = payloadBuffer({ action: "closed" });
  const second = await handleGithubWebhook({
    store,
    sourceId: "github-main",
    githubEvent: "pull_request",
    githubDelivery: "delivery-conflict",
    githubSignature256: sign(secondBody),
    rawBody: secondBody,
    requestId: "req-conflict-2",
  });
  assert.equal(second.statusCode, 409);
  assert.equal(expectError(second.body).error.code, "IDEMPOTENCY_CONFLICT");
}

function payloadBuffer(extra: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(extra), "utf8");
}

function sign(body: Buffer, secret = "github-webhook-secret"): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function expectAccepted(body: GithubWebhookResponse): GithubWebhookAcceptedResponse {
  if ("error" in body) assert.fail(`Expected accepted response, got error ${body.error.code}.`);
  if (body.status === "ignored") assert.fail("Expected queued or duplicate response, got ignored.");
  return body;
}

function expectIgnored(body: GithubWebhookResponse): GithubWebhookIgnoredResponse {
  if ("error" in body) assert.fail(`Expected ignored response, got error ${body.error.code}.`);
  if (body.status !== "ignored") assert.fail(`Expected ignored response, got ${body.status}.`);
  return body;
}

function expectError(body: GithubWebhookResponse): GithubWebhookErrorResponse {
  assert.ok("error" in body);
  return body;
}
