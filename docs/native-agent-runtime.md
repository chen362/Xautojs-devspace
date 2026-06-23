# Native Agent Runtime

Xautojs owns a first-party native local agent runtime. Codex and Claude Code
remain reference systems for ideas, but the runtime contract, storage, policy,
workflow mapping, approval flow, replay model, and operator controls are
Xautojs-native.

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
typed runtime hooks
workflow packs with stable loop steps
event-sourced approval request/resolve records
terminal-run retry creation
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

When a native agent run reaches a terminal state, the linked automation run is
updated to the corresponding terminal automation state.

`agent_run_events` is append-only and cursor-readable by `afterSeq`. Operators
can safely replay a run from sequence `0`, tail new events from the latest
`nextSeq` value, and reconstruct approval state from the event stream.

## Loop Contract

Every dispatched run writes structured loop events around raw process output:

```text
run.started
run.loop.started
run.loop.step
run.output_delta
run.loop.completed | run.loop.failed
run.succeeded | run.failed | run.cancelled | run.timed_out
```

Workflow packs define the stable step list. This gives operators a replayable
view of intent and progress even before a richer model-driven agent loop is
plugged in.

Queued native runs can now be dispatched directly:

```bash
devspace agent dispatch-run --id <agentRunId> --workspace-root <path>
```

This is separate from automation claiming. It lets retry-created runs and future
manual native runs execute through the same policy, hook, process, and event
pipeline.

## Dispatcher Contract

The automation dispatcher claims queued automation work exactly once:

```bash
devspace agent dispatch-once --automation-run-id <automationRunId> --workspace-root <path>
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
  blocks high-risk shell/network/destructive commands by default

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
buildPrompt(input)
```

GitHub automation metadata defaults to `github-pr-review`. A source or run can
select a workflow with `metadata.workflowId` when it maps to a known workflow id.
Unknown workflow ids fall back to `manual`.

`security-review` defaults to `read_only`, which means it cannot execute the
native process bootstrap unless the workflow/profile is intentionally changed in
future policy work.

## Runtime Hooks

Runtime hooks are typed and auditable:

```text
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

Hook records are stored in `agent_runtime_hooks`. The first default hooks are
policy-shaped audit/block decisions; they are intentionally small so the runtime
can grow without hidden side effects.

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

Replay returns the full event stream, folded approvals, next sequence cursor,
and terminal flag.

## Operator API

The operator API is mounted under:

```text
/api/native-agent
```

It requires:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Available endpoints:

```text
GET  /api/native-agent/runs
GET  /api/native-agent/runs/:agentRunId
GET  /api/native-agent/runs/:agentRunId/events?afterSeq=0&maxEvents=100
GET  /api/native-agent/runs/:agentRunId/replay
GET  /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals/:approvalId/resolve
POST /api/native-agent/runs/:agentRunId/retry
POST /api/native-agent/runs/:agentRunId/cancel
POST /api/native-agent/dispatch/once
POST /api/native-agent/dispatch/run
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
devspace agent workflows
devspace agent dispatch-once --workspace-root <path>
devspace agent dispatch-run --id <agentRunId> --workspace-root <path>
devspace agent list
devspace agent events --id <agentRunId>
devspace agent replay --id <agentRunId>
devspace agent retry --id <agentRunId>
devspace agent approvals --id <agentRunId>
devspace agent request-approval --id <agentRunId> --message <text>
devspace agent approve --id <agentRunId> --approval-id <approvalId>
devspace agent deny --id <agentRunId> --approval-id <approvalId>
devspace agent cancel --id <agentRunId>
```

Most commands support `--json` for automation-friendly output.

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
