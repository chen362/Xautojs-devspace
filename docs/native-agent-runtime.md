# Native Agent Runtime

Xautojs owns a first-party native local agent runtime. Codex and Claude Code
remain reference systems for ideas, but the runtime contract, storage, policy,
workflow mapping, approval flow, replay model, hooks, and operator controls are
Xautojs-native.

The examples below assume a source checkout that has already run `npm run build`.
Use `node dist/cli.js ...` from the repository root. A future global package can
expose the same commands through the `devspace` binary.

## Goals

The native runtime turns queued automation runs into auditable local execution.
It is designed for Linux, macOS, and Windows-compatible Node environments without
requiring a Codex or Claude Code binary.

The runtime supports:

```text
Postgres-backed native agent run storage
queued automation run claiming
queued native agent run dispatch
cursor-readable and replayable run events
first-party process execution contract
permission profiles and command policy
interactive approval pause/resume gates
typed runtime hooks
configurable before/after runtime hook pipeline
workflow packs with stable plan/execute/verify/handoff steps
event-sourced approval request/resolve records
terminal-run retry creation
operator-focused replay summaries
operator HTTP APIs
operator CLI commands
```

## Storage Contract

Postgres migration `0004_native_agent_runtime.sql` adds these tables:

```text
agent_runs
agent_run_events
agent_tool_calls
agent_runtime_hooks
```

`agent_runs` is owner-scoped with `tenant_id` and `user_id`, and may link back to
an `automation_run_id`. The native status model is more detailed than the coarse
automation status:

```text
queued
claiming
running
waiting_input
succeeded
failed
cancelled
timed_out
```

Automation runs stay coarse-grained:

```text
queued
running
succeeded
failed
cancelled
```

When a native agent run waits for approval, the native run moves to
`waiting_input` while the linked automation run remains `running`. When a native
agent run reaches a terminal state, the linked automation run is updated to the
corresponding terminal automation state.

`agent_run_events` is append-only and cursor-readable by `afterSeq`. Operators
can safely replay a run from sequence `0`, tail new events from the latest
`nextSeq` value, and reconstruct approval, hook, workflow-step, and retry state
from the event stream.

## Loop Contract

Every dispatched run writes structured loop events around raw process output:

```text
run.started
run.loop.started
run.loop.step
run.hook.decision
run.waiting_input
run.approval.requested
run.approval.resolved
run.approval.accepted
run.resumed
run.output_delta
run.loop.completed | run.loop.failed
run.retry.created
run.retry.source
run.succeeded | run.failed | run.cancelled | run.timed_out
```

`run.waiting_input`, `run.approval.*`, and `run.resumed` are present only when
policy or hooks require operator approval. Retry events are present only when an
operator creates a retry from a terminal native run.

Workflow packs define the stable step list and execution plan. This gives
operators a replayable view of intent, phase, expected output, and acceptance
criteria even before a richer model-driven agent loop is plugged in.

Queued native runs can be dispatched directly:

```bash
node dist/cli.js agent dispatch-run --id <agentRunId> --workspace-root <path>
```

A waiting run is resumed through the same execution pipeline:

```bash
node dist/cli.js agent resume --id <agentRunId> --workspace-root <path>
```

This is separate from automation claiming. It lets retry-created runs, waiting
runs, and future manual native runs execute through the same policy, hook,
process, and event pipeline.

## Dispatcher Contract

The automation dispatcher claims queued automation work exactly once:

```bash
node dist/cli.js agent dispatch-once --automation-run-id <automationRunId> --workspace-root <path>
```

If `--automation-run-id` is omitted, the dispatcher claims the oldest queued run.
For Postgres this uses row locking with `for update skip locked`.

A claimed automation run creates one native `agent_run`. If the automation run is
already claimed or already has an agent run, the dispatcher returns idle/no-op
instead of creating duplicate work.

Workspace resolution follows this order:

```text
1. explicit --workspace-root / API workspaceRoot
2. stored workspace_session_id on the automation run or native run
```

Every resolved path is checked against `allowedRoots` or `worktreeRoot` before
execution.

## Process Engine

The native process engine is intentionally shell-independent:

```text
spawn argv directly with shell=false
use process.execPath for built-in workflow bootstrap commands
set windowsHide=true
stream stdout/stderr as sequenced chunks
support stdin writes with inputId dedupe
support cancel and hard timeout
apply output byte caps
```

This is the main cross-platform compatibility rule. Workflow bootstrap code must
not assume Bash, PowerShell, `cmd.exe`, `/bin/sh`, or GNU-only command syntax.

## Permission Profiles

Initial permission profiles are:

```text
read_only:
  blocks native process execution

workspace_write:
  allows internal workflow process execution inside workspaceRoot
  requires approval for high-risk shell/network/destructive commands

trusted_local:
  allows low/medium-risk local commands
  records high-risk commands as audit_only instead of silently allowing them
```

Policy evaluates:

```text
permission profile
argv
cwd
workspaceRoot
internal workflow marker
command risk classification
```

A webhook payload is never trusted as a raw shell command. External events may
select a workflow, but executable argv is produced by first-party Xautojs workflow
code.

## Approval Gates

Policy and hooks can return these decisions:

```text
allow       execute immediately
ask         pause the run and request approval
block       fail the run before execution
deny        fail or deny the requested permission path
audit_only  execute but record the high-risk decision
```

When the decision is `ask`, runtime behavior is stable:

```text
1. Write run.approval.requested if an equivalent approval is not already present.
2. Move the native run to waiting_input.
3. Return dispatch status waiting_input with NATIVE_APPROVAL_REQUIRED.
4. Keep the linked automation run in running.
5. Reuse the same approval on repeated dispatch attempts.
6. After approval, dispatch/resume writes run.approval.accepted and run.resumed.
7. After denial, dispatch/resume finishes failed with NATIVE_APPROVAL_DENIED.
8. After timeout, dispatch/resume finishes timed_out with NATIVE_APPROVAL_TIMEOUT.
```

Equivalent policy approvals are matched by a stable fingerprint over title,
message, risk, and request payload. This prevents repeated resume attempts from
creating duplicate approval prompts.

Approval timeout defaults to 15 minutes. Operators can override it with
`approvalTimeoutMs` through API dispatch/resume calls, or `--approval-timeout-ms`
through the CLI.

## Workflow Packs

Built-in workflow packs:

```text
manual
github-pr-review
feature-dev
security-review
test-fix
```

Each pack has:

```text
id
title
description
permissionProfile
steps[]
successCriteria[]
failureModes[]
buildPrompt(input)
```

Each step is no longer just display text. It is a durable execution contract:

```text
id
title
phase: plan | execute | verify | handoff
action: observe | decide | modify | test | report
objective
expectedOutput
acceptanceCriteria[]
suggestedTools[]
```

The runtime builds an `executionPlan` with version
`native-workflow-pack/v1` and stores it in both:

```text
DEVSPACE_NATIVE_AGENT_INPUT.executionPlan
agent_runs.result.executionPlan
```

`run.loop.started` includes plan-level phases, success criteria, and failure
modes. Every `run.loop.step` includes phase, action, expected output, acceptance
criteria, and suggested tools. This is the contract that lets future real agent
loops move from static bootstrap output toward plan/execute/verify behavior
without changing the operator replay model again.

GitHub automation metadata defaults to `github-pr-review`. A source or run can
select a workflow with `metadata.workflowId` when it maps to a known workflow id.
Unknown workflow ids fall back to `manual`.

`security-review` defaults to `read_only`, which means it cannot execute the
native process bootstrap unless the workflow/profile is intentionally changed in
future policy work.

## Runtime Hooks

Runtime hooks are typed and auditable:

```text
Start
WorkflowStep
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

Every hook decision is appended to `agent_run_events` as:

```text
run.hook.decision
```

This event is the durable replay source for all hook decisions, including
lifecycle hooks such as `Start` and workflow-step hooks such as `WorkflowStep`.
Operator replay and `replay.summary.hooks` should be built from this event stream.

`agent_runtime_hooks` is a legacy/audit table for this stable subset only:

```text
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

`Start` and `WorkflowStep` are intentionally not written to `agent_runtime_hooks`
because the current Postgres check constraint for `agent_runtime_hooks.hook_event_name`
only accepts the legacy subset above. Use `run.hook.decision` to inspect lifecycle
and workflow-step hook decisions.

Default hooks remain enabled for safety: they turn high-risk pre-tool decisions
into `ask`, block policy-denied actions, and audit lifecycle events. Configured
rules extend the pipeline; they are not an escape hatch around command policy.

The runtime binds workflow packs into the hook payloads:

```text
Start:
  stage=before
  workflowId
  permissionProfile
  workspaceRoot
  executionPlan

WorkflowStep:
  stage=before
  workflowId
  executionPlanVersion
  stepIndex
  stepId
  stepPhase
  stepAction
  expectedOutput
  acceptanceCriteria
  suggestedTools

PreToolUse / PermissionRequest:
  stage=before
  toolName
  workflowId
  executionPlanVersion
  risk
  decision
  reason

PostToolUse / Stop:
  stage=after
  workflowId
  executionPlanVersion
  status
```

Operators can add rule-based hooks with `DEVSPACE_NATIVE_RUNTIME_HOOKS`. The
value is JSON:

```json
{
  "enabled": true,
  "rules": [
    {
      "id": "ask-high-risk-process",
      "events": ["PreToolUse"],
      "stages": ["before"],
      "risks": ["high"],
      "decision": "ask",
      "reason": "High-risk native process execution needs operator approval."
    },
    {
      "id": "block-feature-plan",
      "events": ["WorkflowStep"],
      "workflowIds": ["feature-dev"],
      "stepPhases": ["plan"],
      "decision": "block",
      "reason": "Feature planning is temporarily disabled by local policy."
    }
  ]
}
```

Rule match fields are optional except `id`, `events`, and `decision`:

```text
stages: before | after
workflowIds
stepPhases: plan | execute | verify | handoff
toolNames
risks: low | medium | high
policyDecisions: allow | block | ask | deny | audit_only
```

Decision merging is conservative. A later `allow` cannot downgrade an earlier
`ask`, `deny`, or `block`. `block` and `deny` stop the hook pipeline and fail the
run before the native process starts. `ask` participates in the existing approval
flow when returned from `PreToolUse` or `PermissionRequest`.

## Approval, Retry, And Replay

Approvals are event-sourced in `agent_run_events` rather than stored in a
separate table:

```text
run.approval.requested
run.approval.resolved
```

A resolved approval is folded from the event stream into:

```text
pending
approved
denied
```

Retries are created only from terminal native runs. A retry creates a new queued
`agent_run` with the same owner, workflow, workspace session, permission profile,
and input plus retry metadata:

```text
retryOfAgentRunId
retryReason
```

The source and retry runs get durable linking events:

```text
run.retry.created
run.retry.source
```

Replay returns the raw event stream, folded approvals, next sequence cursor,
terminal flag, and an operator-focused summary:

```text
replay.agentRunId
replay.events[]
replay.approvals[]
replay.nextSeq
replay.terminal
replay.summary
```

The stable summary shape includes:

```text
replay.summary.agentRunId
replay.summary.workflowId
replay.summary.status
replay.summary.attempt
replay.summary.permissionProfile
replay.summary.terminal
replay.summary.eventCount
replay.summary.nextSeq
replay.summary.approvals.total
replay.summary.approvals.pending
replay.summary.approvals.approved
replay.summary.approvals.denied
replay.summary.approvals.latestPending
replay.summary.hooks.total
replay.summary.hooks.allow
replay.summary.hooks.ask
replay.summary.hooks.block
replay.summary.hooks.deny
replay.summary.hooks.auditOnly
replay.summary.hooks.blocking[]
replay.summary.hooks.latest[]
replay.summary.workflowSteps[]
replay.summary.retries.retryOfAgentRunId
replay.summary.retries.retryAgentRunIds[]
```

`summary.workflowSteps[]` folds `run.loop.step` and matching `run.hook.decision`
events so operators can see step phase/action, hook decision, rule id, reason,
and whether the step was recorded or blocked.

`summary.hooks.blocking[]` contains hook decisions where the hook blocked or
denied progress. `summary.hooks.latest[]` gives recent hook decisions for quick
inspection without reading the entire raw event stream.

## Operator API

The operator API is mounted under:

```text
/api/native-agent
```

It requires:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Operator APIs require Postgres mode with ready migrations. In local source
checkouts, use `node dist/cli.js db status --json` and `node dist/cli.js db migrate`
to prepare the schema.

Available endpoints:

```text
GET  /api/native-agent/runs
GET  /api/native-agent/runs/:agentRunId
GET  /api/native-agent/runs/:agentRunId/events?afterSeq=0&maxEvents=100
GET  /api/native-agent/runs/:agentRunId/replay
GET  /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals/:approvalId/resolve
POST /api/native-agent/runs/:agentRunId/resume
POST /api/native-agent/runs/:agentRunId/retry
POST /api/native-agent/runs/:agentRunId/cancel
POST /api/native-agent/dispatch/once
POST /api/native-agent/dispatch/run
```

Dispatch and resume accept:

```json
{
  "workspaceRoot": "/path/to/workspace",
  "timeoutMs": 5000,
  "approvalTimeoutMs": 900000
}
```

Stable waiting response shape:

```json
{
  "claimed": true,
  "status": "waiting_input",
  "errorCode": "NATIVE_APPROVAL_REQUIRED",
  "errorMessage": "Approve high-risk native command",
  "agentRun": {
    "status": "waiting_input"
  },
  "requestId": "..."
}
```

Stable error response shape:

```json
{
  "error": {
    "code": "NATIVE_AGENT_API_FAILED",
    "message": "Native agent API request failed.",
    "requestId": "...",
    "retryable": true
  }
}
```

## Operator CLI

Native agent commands:

```bash
node dist/cli.js agent workflows
node dist/cli.js agent dispatch-once --workspace-root <path>
node dist/cli.js agent dispatch-run --id <agentRunId> --workspace-root <path>
node dist/cli.js agent resume --id <agentRunId> --workspace-root <path>
node dist/cli.js agent list
node dist/cli.js agent events --id <agentRunId>
node dist/cli.js agent replay --id <agentRunId>
node dist/cli.js agent retry --id <agentRunId>
node dist/cli.js agent approvals --id <agentRunId>
node dist/cli.js agent request-approval --id <agentRunId> --message <text>
node dist/cli.js agent approve --id <agentRunId> --approval-id <approvalId>
node dist/cli.js agent deny --id <agentRunId> --approval-id <approvalId>
node dist/cli.js agent cancel --id <agentRunId>
```

Dispatch and resume support:

```bash
--timeout-ms <ms>
--approval-timeout-ms <ms>
```

Most commands support `--json` for automation-friendly output.

`node dist/cli.js agent replay --id <agentRunId>` prints an operator-focused
summary by default. Use `--json` when an integration needs the full replay shape.

## Three-Platform Compatibility

The native runtime is written to avoid platform-specific process assumptions:

```text
Linux: supported through Node spawn argv
macOS: supported through Node spawn argv
Windows: supported through Node spawn argv without shell=true
```

The existing MCP shell tool may still require a Bash-compatible shell for manual
workspace sessions, but the native agent process engine itself does not require
Bash for built-in workflow execution.

## Current Non-Goals

Still out of scope:

```text
hard dependency on Codex CLI
hard dependency on Claude Code CLI
proxying /v1/responses as the core runtime
general remote code execution outside allowed roots
raw webhook payload execution
multi-machine worker scheduling
full browser UI for workflow and source policy editing
```

## Verification

Core coverage lives in:

```text
src/native-agent-policy.test.ts
src/native-agent-hooks.test.ts
src/native-agent-process.test.ts
src/native-agent-workflows.test.ts
src/native-agent-store.test.ts
src/native-agent-operator.test.ts
src/native-agent-runtime.test.ts
src/native-agent-api.test.ts
```

Run:

```bash
npm run typecheck
npm test
```
