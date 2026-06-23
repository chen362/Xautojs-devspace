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
  assert.match(execution.prompt, /GitHub pull request/i);
  assert.match(execution.prompt, /chen362\/Xautojs-devspace/);

  const envInput = JSON.parse(execution.env.DEVSPACE_NATIVE_AGENT_INPUT) as Record<string, unknown>;
  assert.equal(envInput.workflowId, "github-pr-review");
  assert.equal(envInput.repository, "chen362/Xautojs-devspace");
  assert.equal(envInput.branch, "Xautojs-devspace");
}

{
  const execution = buildNativeWorkflowExecution({ workflowId: "security-review" });
  assert.equal(execution.workflow.id, "security-review");
  assert.equal(execution.permissionProfile, "read_only");
  assert.match(execution.prompt, /read-only security review/i);
}
