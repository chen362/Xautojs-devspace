import assert from "node:assert/strict";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import type { AutomationRun } from "./postgres-automation-store.js";

const store = new InMemoryNativeAgentStore();
const automationRun: AutomationRun = {
  id: "auto_run_1",
  tenantId: "tenant-a",
  userId: "alice",
  eventId: "auto_evt_1",
  status: "queued",
  workspaceSessionId: "ws_1",
  devspaceConversationId: "conv_1",
  attempt: 1,
  metadata: {
    provider: "github",
    repository: "chen362/Xautojs-devspace",
    branch: "Xautojs-devspace",
    eventType: "github.pull_request.opened",
  },
  result: { text: "Review this PR" },
  createdAt: "2026-06-23T00:00:00.000Z",
};
store.seedAutomationRun(automationRun);

const claimed = await store.claimAutomationRun({ automationRunId: "auto_run_1" });
assert.ok(claimed);
assert.equal(claimed.automationRunId, "auto_run_1");
assert.equal(claimed.workspaceSessionId, "ws_1");
assert.equal(claimed.workflowId, "github-pr-review");
assert.equal(claimed.status, "running");
assert.equal(store.automationRuns.get("auto_run_1")?.status, "running");
assert.equal(await store.claimAutomationRun({ automationRunId: "auto_run_1" }), undefined);

const first = await store.appendRunEvent({
  agentRunId: claimed.id,
  type: "run.started",
  payload: { workflowId: claimed.workflowId },
});
const second = await store.appendRunEvent({
  agentRunId: claimed.id,
  type: "run.output_delta",
  payload: { stream: "stdout", text: "ok" },
});
assert.equal(first.seq, 1);
assert.equal(second.seq, 2);
assert.deepEqual((await store.readRunEvents({ agentRunId: claimed.id, afterSeq: 1 })).map((event) => event.type), [
  "run.output_delta",
]);

const toolCall = await store.recordToolCallStart({
  agentRunId: claimed.id,
  toolName: "process",
  risk: "low",
  input: { argv: [process.execPath, "-e"] },
});
assert.equal(toolCall.status, "running");
assert.equal((await store.finishToolCall({ id: toolCall.id, status: "succeeded", result: { ok: true } }))?.status, "succeeded");

const hook = await store.recordRuntimeHook({
  agentRunId: claimed.id,
  hookEventName: "PreToolUse",
  decision: "allow",
  payload: { toolName: "process" },
});
assert.equal(hook.decision, "allow");
assert.equal(store.hooks.length, 1);

const finished = await store.finishAgentRun({
  agentRunId: claimed.id,
  status: "succeeded",
  result: { workflowId: "github-pr-review" },
});
assert.equal(finished?.status, "succeeded");
assert.equal(store.automationRuns.get("auto_run_1")?.status, "succeeded");
assert.deepEqual(store.automationRuns.get("auto_run_1")?.result, { workflowId: "github-pr-review" });

assert.equal((await store.getAgentRun(claimed.id, { tenantId: "tenant-a", userId: "alice" }))?.id, claimed.id);
assert.equal(await store.getAgentRun(claimed.id, { tenantId: "tenant-a", userId: "bob" }), undefined);
assert.deepEqual(
  (await store.listAgentRuns({ owner: { tenantId: "tenant-a", userId: "alice" }, status: "succeeded" })).map((run) => run.id),
  [claimed.id],
);
