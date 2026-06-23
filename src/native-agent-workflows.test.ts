import assert from "node:assert/strict";
import {
  buildNativeWorkflowExecution,
  getNativeWorkflowPack,
  listNativeWorkflowPacks,
  workflowIdFromAutomationMetadata,
  workflowInputFromAgentInput,
} from "./native-agent-workflows.js";

assert.deepEqual(
  listNativeWorkflowPacks().map((workflow) => workflow.id),
  ["manual", "github-pr-review", "feature-dev", "security-review", "test-fix"],
);
assert.equal(getNativeWorkflowPack("unknown").id, "manual");
assert.equal(workflowIdFromAutomationMetadata({ provider: "github" }), "github-pr-review");
assert.equal(workflowIdFromAutomationMetadata({ workflowId: "security-review", provider: "github" }), "security-review");
assert.ok(getNativeWorkflowPack("feature-dev").steps.length >= 3);
assert.deepEqual(getNativeWorkflowPack("feature-dev").steps.map((step) => step.phase), ["plan", "execute", "verify", "handoff"]);
assert.ok(getNativeWorkflowPack("feature-dev").steps.every((step) => step.acceptanceCriteria.length > 0));
assert.ok(getNativeWorkflowPack("feature-dev").successCriteria.length > 0);
assert.ok(getNativeWorkflowPack("feature-dev").failureModes.length > 0);

{
  const input = workflowInputFromAgentInput({
    automationRunId: "auto_run_1",
    workflowId: "github-pr-review",
    text: "Review this PR",
    metadata: {
      provider: "github",
      repository: "chen362/Xautojs-devspace",
      branch: "Xautojs-devspace",
      eventType: "github.pull_request.opened",
    },
  });
  const execution = buildNativeWorkflowExecution(input);
  assert.equal(execution.workflow.id, "github-pr-review");
  assert.equal(execution.permissionProfile, "workspace_write");
  assert.equal(execution.argv[0], process.execPath);
  assert.equal(execution.argv[1], "-e");
  assert.equal(execution.steps[0]?.id, "normalize-event");
  assert.equal(execution.steps[0]?.phase, "plan");
  assert.equal(execution.steps[0]?.action, "observe");
  assert.match(execution.steps[0]?.expectedOutput ?? "", /normalized review target/i);
  assert.ok(execution.steps[0]?.acceptanceCriteria.length);
  assert.deepEqual(execution.executionPlan.phases, ["plan", "execute", "verify", "handoff"]);
  assert.equal(execution.executionPlan.version, "native-workflow-pack/v1");
  assert.equal(execution.executionPlan.workflowId, "github-pr-review");
  assert.match(execution.prompt, /GitHub pull request/i);
  assert.match(execution.prompt, /chen362\/Xautojs-devspace/);

  const envInput = JSON.parse(execution.env.DEVSPACE_NATIVE_AGENT_INPUT) as Record<string, unknown>;
  assert.equal(envInput.workflowId, "github-pr-review");
  assert.equal(envInput.repository, "chen362/Xautojs-devspace");
  assert.equal(envInput.branch, "Xautojs-devspace");
  assert.ok(Array.isArray(envInput.steps));
  assert.equal((envInput.executionPlan as { version?: string }).version, "native-workflow-pack/v1");
}

{
  const execution = buildNativeWorkflowExecution({ workflowId: "security-review" });
  assert.equal(execution.workflow.id, "security-review");
  assert.equal(execution.permissionProfile, "read_only");
  assert.equal(execution.steps[0]?.id, "scope");
  assert.equal(execution.steps[0]?.phase, "plan");
  assert.deepEqual(execution.executionPlan.phases, ["plan", "execute", "verify"]);
  assert.match(execution.prompt, /read-only security review/i);
}
