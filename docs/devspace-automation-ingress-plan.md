# Xautojs DevSpace Automation And Native Agent Plan

Last updated: 2026-06-23

## 0. Current Position

Xautojs DevSpace is no longer just an automation-ingress plan. The default branch
now contains the local MCP workspace bridge, production identity/state
foundations, Postgres-backed automation ingress, and a first-party native local
agent runtime with operator controls.

Current state:

```text
Local workspace MCP bridge: done
Production identity, owner scoping, readiness: done
Automation source/event/run capture: done
HTTP automation trigger: done
Automation source token CLI: done
GitHub webhook receiver: done
GitHub webhook source policy/routing: done
Owner-token OAuth SQLite persistence: done
Native local agent runtime store and dispatcher: done
Native process engine: done
Permission profiles and approval pause/resume: done
Workflow packs and execution plans: done
Runtime hook pipeline: done
Operator replay/approval/retry UX: done
README/package identity split from upstream DevSpace: done
```

The important product decision remains:

```text
Xautojs owns the native runtime.
Codex and Claude Code are reference systems, not runtime dependencies.
Do not turn Xautojs into a wrapper around Codex or Claude Code.
```

Codex is useful as a reference for process/session/policy design. Claude Code is
useful as a reference for commands, hooks, workflow packs, and specialized agent
organization. Xautojs absorbs useful ideas while keeping implementation,
storage, contracts, hooks, workflow packs, and operator controls independent.

## 1. What Already Exists

### 1.1 Local MCP Workspace Core

Xautojs exposes local coding workspaces through MCP tools.

Implemented capabilities:

```text
open_workspace
read/read_file
write/write_file
edit/edit_file
grep/grep_files
glob/find_files
ls/list_directory
bash/run_shell
show_changes when change widgets are enabled
```

Workspace behavior includes:

```text
allowed root enforcement
checkout and managed worktree modes
workspaceId reuse across tool calls
workspace session persistence and restoration
loaded AGENTS.md and CLAUDE.md files
nested AGENTS.md and CLAUDE.md discovery
local skill discovery and skill file activation
review checkpoints and aggregate diff cards
```

### 1.2 Identity, Storage, And Production Readiness

Implemented production foundations:

```text
owner-token local auth
OIDC auth mode
DevSpace identity derived from auth context
tenantId/userId owner scoping for workspace sessions
MCP session identity mismatch protection
SQLite workspace state for local use
Postgres workspace state for production use
Postgres schema migrations and readiness checks
GET /healthz liveness
GET /readyz readiness
workspace session TTL cleanup
```

Implemented local OAuth persistence:

```text
OAuth clients persisted in SQLite
access tokens persisted by hash
refresh tokens persisted by hash
transactional refresh-token rotation
refresh-token reuse rejection
SQLite state directory 0700 where supported
SQLite database file 0600 where supported
WAL, synchronous=NORMAL, busy_timeout, foreign keys
versioned SQLite migrations
clean SQLite close on shutdown path
```

### 1.3 Automation Ingress

Implemented automation storage and API foundation:

```text
automation_sources
automation_events
automation_runs
source token hashes
source enable/disable status
owner-scoped source/event/run access
idempotency by source_event_id and idempotency_key
request fingerprint conflict detection
queued automation run creation
```

Implemented generic trigger endpoint:

```text
POST /api/automation/triggers/:triggerId/fire
```

Implemented GitHub webhook endpoint:

```text
POST /api/automation/github/webhooks/:sourceId
```

GitHub webhook behavior:

```text
requires source kind github_webhook
requires enabled source
requires secretRef=env:VARIABLE_NAME
verifies X-Hub-Signature-256 over raw body
requires X-GitHub-Event and X-GitHub-Delivery
uses X-GitHub-Delivery as sourceEventId and idempotency key
normalizes eventType as github.<event>.<action>
extracts repository, sender, and branch metadata when present
```

Routing policy example:

```json
{
  "events": {
    "pull_request": ["opened", "synchronize", "closed"],
    "release": ["published"]
  },
  "repositories": ["chen362/Xautojs-devspace"],
  "branches": ["Xautojs-devspace"]
}
```

Delivery outcomes:

```text
queued:
  store automation_event with status=accepted
  create or reuse queued automation_run

ignored:
  store automation_event with status=rejected
  do not create automation_run
  still return 202 so GitHub does not retry intentionally ignored work

duplicate:
  return original event/run ids when the fingerprint matches
  return 409 IDEMPOTENCY_CONFLICT when the same delivery/key has a new fingerprint
```

### 1.4 Native Agent Runtime

Implemented native runtime storage:

```text
agent_runs
agent_run_events
agent_tool_calls
agent_runtime_hooks
```

Native run status model:

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

Runtime capabilities now include:

```text
queued automation run claiming
queued native agent run dispatch
cursor-readable event stream
shell-independent process engine for first-party workflow bootstrap
permission profiles: read_only, workspace_write, trusted_local
approval pause/resume for high-risk decisions
workflow packs with executionPlan version native-workflow-pack/v1
typed runtime hooks with configurable rules
run.hook.decision event mirroring for replay
terminal-run retry creation
operator HTTP APIs
operator CLI commands
operator-focused replay summaries
```

## 2. Native Agent Contract

The current native runtime is first-party and independent from external agent
CLIs. Automation ingress can create queued work; the native dispatcher can claim
that work and create a durable `agent_run`; operator APIs and CLI can inspect,
replay, approve, resume, retry, or cancel runs.

Dispatch flow:

```text
GitHub webhook or generic trigger accepted
  -> automation_event status=accepted
  -> automation_run status=queued
  -> dispatcher claims queued run exactly once
  -> creates agent_run
  -> selects workflow pack and execution plan
  -> evaluates policy and hooks
  -> may pause for approval as waiting_input
  -> executes first-party workflow bootstrap when allowed
  -> streams agent_run_events
  -> updates native and automation terminal state
```

Ignored events remain audit-only and must not create native agent runs.

## 3. Operator Surface

Operator API prefix:

```text
/api/native-agent
```

Operator API auth:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Core operator API routes:

```text
GET  /api/native-agent/runs
GET  /api/native-agent/runs/:agentRunId
GET  /api/native-agent/runs/:agentRunId/events
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

Core operator CLI commands:

```text
devspace agent workflows
devspace agent dispatch-once --workspace-root <path>
devspace agent dispatch-run --id <agentRunId> --workspace-root <path>
devspace agent resume --id <agentRunId> --workspace-root <path>
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

`replay` now returns raw events plus an operator summary. The summary folds
status, approval counts, hook decisions, workflow step state, and retry links so
operators can understand the run without manually reading every event.

## 4. Completed PR Line

Completed implementation sequence:

```text
PR17: Automation ingress plan
PR18: Postgres automation event/run store
PR19: Generic API trigger endpoint
PR20: Automation source token management CLI
PR21: GitHub webhook receiver
PR22: GitHub webhook policy/routing
PR23: Owner-token OAuth SQLite persistence and SQLite hardening
PR24: Native agent runtime store, dispatcher, policy, workflows, hooks, and operator UX baseline
PR25: Approval, retry, replay, dispatch-run, and operator UX expansion
PR26: Native tool policy approval pause and resume
PR27: Native workflow packs with execution plans
PR28: Runtime hooks and workflow-step hook pipeline
PR29: Operator UX replay summaries for run replay, approvals, hooks, workflow steps, and retries
PR30: README and Chinese README refresh
PR31: Package identity renamed away from upstream DevSpace
```

## 5. Recommended Next PRs

Recommended next work should now focus on operator maturity, documentation,
source-to-workflow mapping, and release hygiene rather than building the already
landed runtime foundation.

```text
PR32: Native Agent Operator Documentation Refresh
  Update runtime docs, configuration reference, and operator runbook.
  Document replay.summary and run.hook.decision semantics.
  Add copyable operator CLI/API workflows.

PR33: Automation Source To Workflow Mapping
  Make source config select workflowId, permissionProfile, and workspace policy
  through a stable documented contract.
  Validate unknown workflow/profile values fail closed or fall back explicitly.

PR34: Operator Tail And Runbook Polish
  Add or document a practical tail/poll loop around afterSeq/nextSeq.
  Improve pending approval and blocking hook inspection workflows.

PR35: Package Release Hygiene
  Decide final npm scope/name.
  Regenerate package-lock metadata under the new package name.
  Add release notes and package publish checklist.

PR36: Native Agent Worker Mode
  Add a long-running dispatcher/worker loop when production operators are ready
  for continuous automation-run claiming rather than manual dispatch-once.
```

## 6. Acceptance Criteria For The Current Native Agent Line

Current line is ready when these remain true:

```text
Queued automation runs can be claimed exactly once.
Each claimed run creates at most one native agent_run.
Agent run events are durable and cursor-readable.
A caller can read output using afterSeq/nextSeq.
A caller can cancel a running agent_run.
Timeouts produce stable timed_out terminal state.
Permission decisions are recorded and replayable.
Approval requests are reusable by stable fingerprint.
Hook decisions are visible through run.hook.decision.
Workflow step state is visible in operator replay summary.
Retries preserve source/run links.
GitHub routable events can start configured native workflows.
Ignored GitHub events remain audit-only.
No Codex or Claude Code binary is required for the core runtime.
Codex/Claude-inspired features are reimplemented as Xautojs-native contracts.
```

## 7. Remaining Non-Goals

Still out of scope for this line:

```text
Codex /v1/responses proxy as the primary runtime
hard dependency on Codex CLI
hard dependency on Claude Code CLI
web UI for editing every source policy
GitHub App installation auth
multi-machine distributed worker scheduling
general remote code execution outside allowed roots
raw webhook body retention by default
```

These can be revisited later only after the native Xautojs runtime and operator
runbooks are stable.
