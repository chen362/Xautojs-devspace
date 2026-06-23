import assert from "node:assert/strict";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import { dispatchNativeAgentOnce, dispatchNativeAgentRunOnce } from "./native-agent-runtime.js";
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
