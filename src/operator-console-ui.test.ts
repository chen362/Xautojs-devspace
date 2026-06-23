import assert from "node:assert/strict";
import {
  blockingHookCount,
  chooseRunId,
  compactId,
  decisionTone,
  eventDetail,
  eventTitle,
  filterRuns,
  pendingApproval,
  statusTone,
  summarizeRuns,
  timeAgo,
  type OperatorReplay,
  type OperatorRun,
} from "./ui/operator-model.js";

const runs: OperatorRun[] = [
  {
    id: "agent_run_old_success",
    workflowId: "manual",
    status: "succeeded",
    attempt: 1,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:01:00.000Z",
  },
  {
    id: "agent_run_waiting",
    workflowId: "feature-dev",
    status: "waiting_input",
    attempt: 2,
    createdAt: "2026-06-23T00:02:00.000Z",
    updatedAt: "2026-06-23T00:05:00.000Z",
  },
  {
    id: "agent_run_failed",
    workflowId: "test-fix",
    status: "failed",
    attempt: 1,
    createdAt: "2026-06-23T00:03:00.000Z",
    updatedAt: "2026-06-23T00:04:00.000Z",
  },
];

assert.deepEqual(summarizeRuns([]), {
  total: 0,
  active: 0,
  waiting: 0,
  failed: 0,
  terminal: 0,
});

assert.deepEqual(summarizeRuns(runs), {
  total: 3,
  active: 1,
  waiting: 1,
  failed: 1,
  terminal: 2,
});

assert.equal(chooseRunId(runs), "agent_run_waiting");
assert.equal(chooseRunId(runs, "agent_run_failed"), "agent_run_failed");
assert.deepEqual(filterRuns(runs, "failed").map((run) => run.id), ["agent_run_failed"]);
assert.deepEqual(filterRuns(runs, "all").map((run) => run.id), ["agent_run_waiting", "agent_run_failed", "agent_run_old_success"]);
assert.equal(statusTone("waiting_input"), "warning");
assert.equal(statusTone("succeeded"), "success");
assert.equal(statusTone("failed"), "danger");
assert.equal(decisionTone("ask"), "warning");
assert.equal(decisionTone("deny"), "danger");
assert.equal(decisionTone("audit_only"), "success");
assert.equal(compactId("agent_run_1234567890abcdef"), "agent_run_...abcdef");
assert.equal(timeAgo("2026-06-23T00:00:00.000Z", Date.parse("2026-06-23T00:05:00.000Z")), "5m ago");

const replay: OperatorReplay = {
  agentRunId: "agent_run_waiting",
  events: [
    {
      seq: 1,
      type: "run.hook.decision",
      payload: {
        hookEventName: "WorkflowStep",
        decision: "ask",
        reason: "Needs operator approval",
      },
      createdAt: "2026-06-23T00:05:00.000Z",
    },
  ],
  approvals: [
    {
      id: "approval_1",
      status: "pending",
      title: "Run tests",
      message: "Allow npm test",
      risk: "medium",
      request: { command: "npm test" },
      response: {},
      requestedAt: "2026-06-23T00:06:00.000Z",
    },
  ],
  nextSeq: 2,
  terminal: false,
  summary: {
    agentRunId: "agent_run_waiting",
    workflowId: "feature-dev",
    status: "waiting_input",
    attempt: 2,
    permissionProfile: "workspace_write",
    terminal: false,
    eventCount: 1,
    nextSeq: 2,
    approvals: {
      total: 1,
      pending: 1,
      approved: 0,
      denied: 0,
    },
    hooks: {
      total: 1,
      allow: 0,
      ask: 1,
      block: 0,
      deny: 0,
      auditOnly: 0,
      blocking: [
        {
          seq: 1,
          eventName: "WorkflowStep",
          decision: "ask",
          continue: false,
          auditOnly: false,
          blocking: true,
          createdAt: "2026-06-23T00:05:00.000Z",
        },
      ],
      latest: [],
    },
    workflowSteps: [],
    retries: { retryAgentRunIds: [] },
  },
};

assert.equal(pendingApproval(replay)?.id, "approval_1");
assert.equal(blockingHookCount(replay), 1);
assert.equal(eventTitle(replay.events[0]!), "Hook decision");
assert.equal(eventDetail(replay.events[0]!), "WorkflowStep: ask - Needs operator approval");
