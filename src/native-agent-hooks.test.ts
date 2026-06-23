import assert from "node:assert/strict";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import { defaultNativeRuntimeHooks, NativeRuntimeHookManager } from "./native-agent-hooks.js";
import {
  loadNativeRuntimeHookConfigFromEnv,
  parseNativeRuntimeHookConfig,
} from "./native-agent-hook-config.js";

{
  const config = parseNativeRuntimeHookConfig({
    enabled: true,
    rules: [
      {
        id: "block-feature-plan",
        event: "WorkflowStep",
        stage: "before",
        workflowId: "feature-dev",
        stepPhase: "plan",
        decision: "block",
        reason: "Feature planning is blocked by operator policy.",
      },
    ],
  });

  assert.equal(config.enabled, true);
  assert.equal(config.rules.length, 1);
  assert.deepEqual(config.rules[0]?.events, ["WorkflowStep"]);
  assert.deepEqual(config.rules[0]?.stages, ["before"]);
  assert.deepEqual(config.rules[0]?.workflowIds, ["feature-dev"]);
  assert.deepEqual(config.rules[0]?.stepPhases, ["plan"]);
  assert.equal(config.rules[0]?.decision, "block");
}

{
  const envConfig = loadNativeRuntimeHookConfigFromEnv({
    DEVSPACE_NATIVE_RUNTIME_HOOKS: JSON.stringify({
      rules: [
        {
          id: "ask-high-risk-process",
          events: ["PreToolUse"],
          risks: ["high"],
          decision: "ask",
        },
      ],
    }),
  });
  assert.equal(envConfig.enabled, true);
  assert.equal(envConfig.rules[0]?.id, "ask-high-risk-process");
}

assert.throws(
  () => parseNativeRuntimeHookConfig({ rules: [{ id: "bad", event: "Nope", decision: "allow" }] }),
  /nativeRuntimeHooks\.rules\[0\]\.events contains invalid value: Nope/,
);
assert.throws(
  () => loadNativeRuntimeHookConfigFromEnv({ DEVSPACE_NATIVE_RUNTIME_HOOKS: "{" }),
  /Invalid DEVSPACE_NATIVE_RUNTIME_HOOKS/,
);

{
  const store = new InMemoryNativeAgentStore();
  const hooks = defaultNativeRuntimeHooks({
    enabled: true,
    rules: [
      {
        id: "block-feature-plan",
        events: ["WorkflowStep"],
        stages: ["before"],
        workflowIds: ["feature-dev"],
        stepPhases: ["plan"],
        decision: "block",
        reason: "Feature planning is blocked by operator policy.",
      },
    ],
  });

  const result = await hooks.run(store, {
    agentRunId: "agent_run_hook_test",
    hookEventName: "WorkflowStep",
    payload: {
      stage: "before",
      workflowId: "feature-dev",
      stepPhase: "plan",
    },
  });

  assert.equal(result.decision, "block");
  assert.equal(result.continue, false);
  assert.equal(result.ruleId, "block-feature-plan");
  assert.equal(store.hooks.at(-1)?.hookEventName, "WorkflowStep");
  assert.equal(store.hooks.at(-1)?.decision, "block");
  assert.equal(store.hooks.at(-1)?.result.ruleId, "block-feature-plan");
}

{
  const store = new InMemoryNativeAgentStore();
  const hooks = new NativeRuntimeHookManager();
  hooks.register("PreToolUse", () => ({
    decision: "ask",
    continue: true,
    auditOnly: false,
    reason: "Approval is required.",
  }));
  hooks.register("PreToolUse", () => ({
    decision: "allow",
    continue: true,
    auditOnly: false,
    reason: "A later rule should not downgrade ask to allow.",
  }));

  const result = await hooks.run(store, {
    hookEventName: "PreToolUse",
    payload: { stage: "before", toolName: "process", risk: "high" },
  });

  assert.equal(result.decision, "ask");
  assert.equal(result.reason, "Approval is required.");
  assert.deepEqual(store.hooks.map((hook) => hook.decision), ["ask", "allow"]);
}
