import assert from "node:assert/strict";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import {
  createNativeAgentRetry,
  ensureNativeAgentPolicyApproval,
  listNativeAgentApprovals,
  replayNativeAgentRun,
  requestNativeAgentApproval,
  resolveNativeAgentApproval,
} from "./native-agent-operator.js";

const store = new InMemoryNativeAgentStore();
const run = await store.createAgentRun({
  id: "agent_run_operator",
  owner: { tenantId: "tenant-a", userId: "alice" },
  workflowId: "feature-dev",
  status: "running",
  permissionProfile: "workspace_write",
  input: { text: "implement feature" },
});
await store.appendRunEvent({ agentRunId: run.id, type: "run.started", payload: { workflowId: "feature-dev" } });
await store.appendRunEvent({
  agentRunId: run.id,
  type: "run.loop.step",
  payload: {
    id: "plan",
    title: "Plan implementation",
    phase: "plan",
    action: "decide",
    expectedOutput: "Implementation plan",
    acceptanceCriteria: ["Plan names the touched files"],
    suggestedTools: ["process"],
  },
});
await store.appendRunEvent({
  agentRunId: run.id,
  type: "run.hook.decision",
  payload: {
    hookEventName: "WorkflowStep",
    decision: "audit_only",
    continue: true,
    auditOnly: true,
    reason: "Native workflow step recorded for audit.",
    hookPayload: {
      stage: "before",
      workflowId: "feature-dev",
      stepId: "plan",
      stepPhase: "plan",
      stepAction: "decide",
    },
  },
});

const requested = await requestNativeAgentApproval(store, {
  agentRunId: run.id,
  approvalId: "approval_1",
  title: "Run tests",
  message: "Allow test execution",
  risk: "medium",
  request: { command: "npm test" },
  requestedBy: "operator-test",
});
assert.equal(requested.status, "pending");
assert.equal(requested.id, "approval_1");

assert.deepEqual((await listNativeAgentApprovals(store, { agentRunId: run.id })).map((approval) => approval.status), ["pending"]);

const resolved = await resolveNativeAgentApproval(store, {
  agentRunId: run.id,
  approvalId: "approval_1",
  decision: "approved",
  response: { message: "ok" },
  resolvedBy: "owner",
});
assert.equal(resolved.status, "approved");
assert.deepEqual(resolved.response, { message: "ok" });
assert.deepEqual((await listNativeAgentApprovals(store, { agentRunId: run.id })).map((approval) => approval.status), ["approved"]);

const policyApproval = await ensureNativeAgentPolicyApproval(store, {
  agentRunId: run.id,
  approvalId: "approval_policy",
  title: "Approve command",
  message: "Allow command",
  risk: "high",
  request: { toolName: "process", argv: ["rm", "-rf", "dist"] },
  timeoutMs: 1_000,
  now: () => new Date("2026-06-23T00:00:00.000Z"),
});
assert.equal(policyApproval.status, "pending");
assert.equal(policyApproval.expiresAt, "2026-06-23T00:00:01.000Z");
assert.equal(policyApproval.request.approvalFingerprint && typeof policyApproval.request.approvalFingerprint, "string");

const reusedPolicyApproval = await ensureNativeAgentPolicyApproval(store, {
  agentRunId: run.id,
  title: "Approve command",
  message: "Allow command",
  risk: "high",
  request: { argv: ["rm", "-rf", "dist"], toolName: "process" },
  timeoutMs: 1_000,
  now: () => new Date("2026-06-23T00:00:00.500Z"),
});
assert.equal(reusedPolicyApproval.id, "approval_policy");
assert.equal(reusedPolicyApproval.status, "pending");

const expiredPolicyApproval = await ensureNativeAgentPolicyApproval(store, {
  agentRunId: run.id,
  title: "Approve command",
  message: "Allow command",
  risk: "high",
  request: { toolName: "process", argv: ["rm", "-rf", "dist"] },
  timeoutMs: 1_000,
  now: () => new Date("2026-06-23T00:00:02.000Z"),
});
assert.equal(expiredPolicyApproval.id, "approval_policy");
assert.equal(expiredPolicyApproval.status, "denied");
assert.equal(expiredPolicyApproval.response.code, "NATIVE_APPROVAL_TIMEOUT");

const replay = await replayNativeAgentRun(store, { agentRunId: run.id });
assert.equal(replay.agentRunId, run.id);
assert.equal(replay.terminal, false);
assert.ok(replay.events.some((event) => event.type === "run.approval.requested"));
assert.equal(replay.approvals[0]?.status, "approved");
assert.equal(replay.nextSeq, replay.events.length + 1);
assert.equal(replay.summary.status, "running");
assert.equal(replay.summary.approvals.total, 2);
assert.equal(replay.summary.approvals.pending, 0);
assert.equal(replay.summary.approvals.approved, 1);
assert.equal(replay.summary.approvals.denied, 1);
assert.equal(replay.summary.hooks.auditOnly, 1);
assert.equal(replay.summary.workflowSteps[0]?.id, "plan");
assert.equal(replay.summary.workflowSteps[0]?.hookDecision, "audit_only");
assert.equal(replay.summary.workflowSteps[0]?.status, "recorded");

await store.finishAgentRun({
  agentRunId: run.id,
  status: "failed",
  errorCode: "TEST_FAILURE",
  errorMessage: "unit failure",
});

const retry = await createNativeAgentRetry(store, {
  agentRunId: run.id,
  retryId: "agent_run_retry_1",
  reason: "fix and retry",
});
assert.equal(retry.status, "queued");
assert.equal(retry.workflowId, "feature-dev");
assert.equal(retry.attempt, 2);
assert.equal(retry.input.retryOfAgentRunId, run.id);
assert.equal(retry.input.retryReason, "fix and retry");
assert.ok((await store.readRunEvents({ agentRunId: run.id })).some((event) => event.type === "run.retry.created"));
assert.ok((await store.readRunEvents({ agentRunId: retry.id })).some((event) => event.type === "run.retry.source"));

const replayAfterRetry = await replayNativeAgentRun(store, { agentRunId: run.id });
assert.equal(replayAfterRetry.summary.terminal, true);
assert.deepEqual(replayAfterRetry.summary.retries.retryAgentRunIds, ["agent_run_retry_1"]);
