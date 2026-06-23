import assert from "node:assert/strict";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import { dispatchNativeAgentOnce, dispatchNativeAgentRunOnce } from "./native-agent-runtime.js";
import { NativeRuntimeHookManager } from "./native-agent-hooks.js";
import { listNativeAgentApprovals, resolveNativeAgentApproval } from "./native-agent-operator.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceStore } from "./workspace-store.js";
import type { AutomationRun } from "./postgres-automation-store.js";

const workspaceRoot = process.cwd();
const config = {
  database: { provider: "sqlite", stateDir: workspaceRoot, filePath: ":memory:" },
  allowedRoots: [workspaceRoot],
  worktreeRoot: workspaceRoot,
} as ServerConfig;
const workspaceStore = {
  async createSession() { throw new Error("workspace store should not be used in this test"); },
  async getSession() { throw new Error("workspace store should not be used in this test"); },
  async saveLoadedAgentFiles() {},
  async getLoadedAgentFiles() { return []; },
  async deleteSession() { return false; },
  async deleteExpiredSessions() { return 0; },
  async touchSession() {},
  async close() {},
} satisfies WorkspaceStore;

{
  const store = new InMemoryNativeAgentStore();
  store.seedAutomationRun(seedRun("auto_run_pr", {
    provider: "github",
    repository: "chen362/Xautojs-devspace",
    branch: "Xautojs-devspace",
    eventType: "github.pull_request.opened",
  }));

  const result = await dispatchNativeAgentOnce(
    config,
    { automationRunId: "auto_run_pr", workspaceRoot, timeoutMs: 5_000 },
    { store, workspaceStore },
  );

  assert.equal(result.claimed, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.agentRun?.workflowId, "github-pr-review");
  assert.equal(store.automationRuns.get("auto_run_pr")?.status, "succeeded");

  const events = await store.readRunEvents({ agentRunId: result.agentRun!.id });
  assert.ok(events.some((event) => event.type === "run.started"));
  assert.ok(events.some((event) => event.type === "run.loop.started"));
  assert.ok(events.some((event) => event.type === "run.loop.step" && event.payload.id === "normalize-event"));
  assert.ok(events.some((event) => event.type === "run.output_delta"));
  assert.ok(events.some((event) => event.type === "run.loop.completed"));
  assert.ok(events.some((event) => event.type === "run.succeeded"));
  assert.match(
    events
      .filter((event) => event.type === "run.output_delta")
      .map((event) => String(event.payload.text ?? ""))
      .join(""),
    /github-pr-review/,
  );
  assert.deepEqual(store.hooks.map((hook) => hook.hookEventName), ["PreToolUse", "PostToolUse", "Stop"]);
}

{
  const store = new InMemoryNativeAgentStore();
  store.seedAutomationRun(seedRun("auto_run_security", { workflowId: "security-review" }));

  const result = await dispatchNativeAgentOnce(
    config,
    { automationRunId: "auto_run_security", workspaceRoot, timeoutMs: 5_000 },
    { store, workspaceStore },
  );

  assert.equal(result.claimed, true);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "NATIVE_POLICY_BLOCKED");
  assert.equal(store.automationRuns.get("auto_run_security")?.status, "failed");
  assert.equal(store.hooks[0]?.hookEventName, "PreToolUse");
  assert.equal(store.hooks[0]?.decision, "block");
  assert.ok((await store.readRunEvents({ agentRunId: result.agentRun!.id })).some((event) => event.type === "run.loop.failed"));
}

{
  const store = new InMemoryNativeAgentStore();
  const run = await store.createAgentRun({
    id: "agent_run_queued",
    owner: { tenantId: "tenant-a", userId: "alice" },
    workflowId: "feature-dev",
    status: "queued",
    input: { text: "Implement a tiny feature" },
  });

  const result = await dispatchNativeAgentRunOnce(
    config,
    { agentRunId: run.id, workspaceRoot, timeoutMs: 5_000 },
    { store, workspaceStore },
  );
  assert.equal(result.claimed, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.agentRun?.status, "succeeded");
  assert.ok((await store.readRunEvents({ agentRunId: run.id })).some((event) => event.type === "run.loop.step" && event.payload.id === "plan"));
}

{
  const store = new InMemoryNativeAgentStore();
  const hooks = new NativeRuntimeHookManager();
  hooks.register("PreToolUse", () => ({
    decision: "ask",
    continue: true,
    auditOnly: false,
    reason: "Test hook requires approval.",
  }));
  hooks.register("PermissionRequest", () => ({
    decision: "allow",
    continue: true,
    auditOnly: false,
    reason: "Permission request can be shown to the operator.",
  }));
  hooks.register("Stop", () => ({
    decision: "audit_only",
    continue: true,
    auditOnly: true,
  }));

  const run = await store.createAgentRun({
    id: "agent_run_waiting",
    owner: { tenantId: "tenant-a", userId: "alice" },
    workflowId: "feature-dev",
    status: "queued",
    input: { text: "Implement a tiny feature with approval" },
  });

  const first = await dispatchNativeAgentRunOnce(
    config,
    { agentRunId: run.id, workspaceRoot, timeoutMs: 5_000, approvalTimeoutMs: 60_000 },
    { store, workspaceStore, hooks, now: () => new Date("2026-06-23T00:00:00.000Z") },
  );
  assert.equal(first.claimed, true);
  assert.equal(first.status, "waiting_input");
  assert.equal(first.agentRun?.status, "waiting_input");
  assert.equal(first.errorCode, "NATIVE_APPROVAL_REQUIRED");
  const approvals = await listNativeAgentApprovals(store, { agentRunId: run.id });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.status, "pending");
  assert.equal(approvals[0]?.expiresAt, "2026-06-23T00:01:00.000Z");

  await resolveNativeAgentApproval(store, {
    agentRunId: run.id,
    approvalId: approvals[0]!.id,
    decision: "approved",
    resolvedBy: "owner",
  });

  const second = await dispatchNativeAgentRunOnce(
    config,
    { agentRunId: run.id, workspaceRoot, timeoutMs: 5_000, approvalTimeoutMs: 60_000 },
    { store, workspaceStore, hooks, now: () => new Date("2026-06-23T00:00:30.000Z") },
  );
  assert.equal(second.claimed, true);
  assert.equal(second.status, "succeeded");
  assert.equal(second.agentRun?.status, "succeeded");
  const events = await store.readRunEvents({ agentRunId: run.id });
  assert.ok(events.some((event) => event.type === "run.waiting_input"));
  assert.ok(events.some((event) => event.type === "run.approval.accepted"));
  assert.ok(events.some((event) => event.type === "run.resumed"));
  assert.ok(events.some((event) => event.type === "run.output_delta"));
}

function seedRun(id: string, metadata: AutomationRun["metadata"]): AutomationRun {
  return {
    id,
    tenantId: "tenant-a",
    userId: "alice",
    eventId: `${id}_event`,
    status: "queued",
    attempt: 1,
    metadata,
    result: { text: "Run native agent" },
    createdAt: "2026-06-23T00:00:00.000Z",
  };
}
