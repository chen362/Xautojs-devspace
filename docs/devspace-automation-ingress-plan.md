# Xautojs / DevSpace Automation And Native Agent Plan

Last updated: 2026-06-23

## 0. Current Position

Xautojs is no longer just planning automation ingress. The project already has a
working local MCP workspace layer, production identity/state foundations, and a
Postgres-backed automation ingress line.

The current stage is:

```text
Local workspace MCP bridge: done
Production identity, owner scoping, readiness: done
Automation source/event/run capture: done
HTTP automation trigger: done
Automation source token CLI: done
GitHub webhook receiver: done
GitHub webhook source policy/routing: done
Owner-token OAuth SQLite persistence: done
Native local agent runtime: next
```

The most important product decision for the next phase:

```text
Xautojs should become its own independent native local agent runtime.
Codex and Claude Code are reference/absorption layers, not runtime dependencies.
Do not turn Xautojs into a wrapper around Codex or Claude Code.
```

Codex is useful as a reference for process/session/policy design. Claude Code is
useful as a reference for commands, hooks, workflow packs, and specialized agent
organization. Xautojs should absorb the ideas and keep the implementation,
storage, contracts, and runtime independent.

## 1. What Already Exists

### 1.1 Local MCP Workspace Core

Xautojs already exposes a real local coding workspace through MCP tools.

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

Workspace behavior already includes:

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

This means the missing piece is not local file access or local command execution.
Those are already present.

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

Contract highlights:

```text
Authorization: Bearer <automation-source-token>
Idempotency-Key: <stable-key>
body requires text or payload
optional sourceEventId/eventId, conversationKey, workspaceHint, metadata
202 returns automationRunId and automationEventId
409 returns IDEMPOTENCY_CONFLICT for reused keys with different fingerprints
```

Implemented automation source CLI:

```text
devspace automation source create
devspace automation source list
devspace automation source rotate-token
```

CLI behavior:

```text
requires Postgres and ready schema
supports local owner mode in local deployment
requires explicit owner binding in production
shows raw token only on create/rotate
stores only sha256 token hashes
supports --json output
```

### 1.4 GitHub Webhook Ingress

Implemented GitHub webhook endpoint:

```text
POST /api/automation/github/webhooks/:sourceId
```

Implemented verification and normalization:

```text
requires source kind github_webhook
requires enabled source
requires secretRef=env:VARIABLE_NAME
verifies X-Hub-Signature-256 over raw body
requires X-GitHub-Event
requires X-GitHub-Delivery
uses X-GitHub-Delivery as sourceEventId and idempotency key
normalizes eventType as github.<event>.<action>
extracts repository, sender, and branch metadata when present
```

Implemented GitHub routing policy:

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

Routing rules:

```text
If config.events is omitted, default routable events are:
  pull_request.opened
  pull_request.synchronize
  pull_request.closed
  release.published

If config.events is present, only explicitly listed event/action pairs route.
If config.repositories is present, repository.full_name must match.
If config.branches is present, branch matching uses:
  pull_request.base.ref
  release.target_commitish
  push.ref with refs/heads/ stripped
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

## 2. Real Gap Now

The remaining product gap is not ingress. The gap is execution.

Today, an automation source can create a queued automation run, and GitHub
webhooks can decide whether a delivery is runnable or audit-only. But queued
runs do not yet enter a native Xautojs agent runtime.

Missing pieces:

```text
native agent run store and event stream
native agent worker/dispatcher
run claiming and concurrency control
streaming output with sequence cursors
stdin/input write path for interactive runs
cancel/timeout handling
agent tool call audit records
permission/policy engine for file, shell, network, and patch operations
workflow packs for repeatable tasks such as PR review and feature development
runtime hooks that can audit or block risky actions
operator APIs or CLI commands to inspect/retry/cancel runs
```

This is the line that turns Xautojs from a local MCP bridge plus automation
inbox into an independent local agent platform.

## 3. Native Agent Direction

Xautojs native agent runtime should be first-party.

Non-goal:

```text
Do not require Codex as the local runtime.
Do not require Claude Code as the local runtime.
Do not implement a Codex wrapper as the main architecture.
Do not implement a Claude Code wrapper as the main architecture.
Do not proxy /v1/responses as the core execution path.
```

Goal:

```text
Xautojs owns the run lifecycle, storage, policy, tools, workflow packs, and audit log.
Codex and Claude Code are studied for good ideas only.
```

Absorb from Codex:

```text
process lifecycle shape: start/read/write/signal/terminate
streaming output chunks with afterSeq/nextSeq cursors
session resume concepts
explicit timeout and cancellation behavior
command policy and approval concepts
sandbox and network permission ideas
output caps and runaway process protection
```

Absorb from Claude Code:

```text
plugin manifest shape
commands as reusable workflows
specialized agents as workflow roles
skills as reusable instruction packs
hooks such as PreToolUse, PostToolUse, PermissionRequest, Stop/PostCompact
code-review, feature-dev, PR review, and security guidance workflows
```

Keep independent in Xautojs:

```text
TypeScript/Node runtime contracts
Postgres/SQLite storage choices
MCP tool surface
owner/tenant identity model
automation source config
audit/error model
policy engine behavior
workflow pack format
```

## 4. Native Agent Contract Draft

### 4.1 Agent Run State

Suggested native status model:

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

`automation_runs.status` can remain the coarse automation state. Native agent
execution should have its own detailed run state so one automation run can later
support retries, attempts, or multiple workflow phases.

Suggested entities:

```text
agent_runs
agent_run_events
agent_tool_calls
agent_processes
```

Minimum `agent_runs` fields:

```text
id
tenant_id
user_id
automation_run_id
workspace_session_id
workflow_id
status
attempt
input_json
result_json
error_code
error_message
created_at
claimed_at
started_at
finished_at
updated_at
```

Minimum `agent_run_events` fields:

```text
id
agent_run_id
seq
event_type
payload_json
created_at
```

Useful event types:

```text
run.started
run.output_delta
run.tool_call.started
run.tool_call.completed
run.permission.requested
run.permission.resolved
run.input.requested
run.cancel_requested
run.succeeded
run.failed
run.timed_out
```

### 4.2 Native Agent Control Surface

A future MCP or internal API surface should expose the same stable semantics
whether the run was created by a webhook, CLI, or ChatGPT MCP session.

Suggested operations:

```text
start_agent_run
read_agent_run
write_agent_run
cancel_agent_run
get_agent_run
```

Draft contract:

```ts
interface StartAgentRunRequest {
  workspaceId: string;
  workflowId?: string;
  prompt: string;
  input?: Record<string, unknown>;
  permissionProfile?: "read_only" | "workspace_write" | "trusted_local";
  timeoutSeconds?: number;
}

interface StartAgentRunResponse {
  agentRunId: string;
  status: "queued" | "running";
  createdAt: string;
}

interface ReadAgentRunRequest {
  agentRunId: string;
  afterSeq?: number;
  maxEvents?: number;
  waitMs?: number;
}

interface ReadAgentRunResponse {
  agentRunId: string;
  status: string;
  events: Array<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  nextSeq: number;
  terminal: boolean;
}

interface WriteAgentRunRequest {
  agentRunId: string;
  inputId: string;
  content: string;
}

interface CancelAgentRunRequest {
  agentRunId: string;
  reason?: string;
}
```

Idempotency and consistency:

```text
start_agent_run may accept an idempotency key when started from automation.
read_agent_run is cursor-based with afterSeq/nextSeq.
write_agent_run requires inputId to reject duplicate user input writes.
cancel_agent_run is idempotent and returns the current terminal/running state.
terminal event order must be stable and replayable from storage.
```

### 4.3 Native Process Engine

The native process engine should support local tools and long-running agent work
without depending on external agent CLIs.

Minimum process contract:

```text
processId scoped to agentRunId
argv/cwd/env policy
pty or non-pty mode
stdout/stderr output chunks
sequence cursor
stdin writes when enabled
interrupt/terminate
hard timeout
output byte cap
process exit event
```

This engine can begin as an internal service and later become a public local
runtime protocol if needed.

### 4.4 Policy And Approval

Xautojs should add its own permission profile model.

Initial profiles:

```text
read_only:
  read/search/list allowed
  write/edit/shell/network denied

workspace_write:
  read/search/list/write/edit allowed inside workspace
  shell allowed only through policy-reviewed commands
  network denied by default

trusted_local:
  read/write/edit/shell allowed inside workspace
  network allowed only if explicitly configured
```

Policy inputs:

```text
tenant/user identity
workspace root
source kind
workflow id
tool name
tool arguments
file paths
command argv
network target if any
risk classification
```

Policy outputs:

```text
allow
block
ask
audit_only
```

Dangerous defaults to keep:

```text
No shell command directly from webhook payload.
No filesystem path trust from external callers.
No cross-owner workspace selection.
No raw token or secret logging.
No bypass around allowedRoots/worktreeRoot.
No agent execution until source config maps to a valid workflow and workspace policy.
```

## 5. Automation Routing Into Native Agent Runs

Automation source config should eventually decide which native workflow starts.

Example GitHub source config extension:

```json
{
  "events": {
    "pull_request": ["opened", "synchronize", "closed"],
    "release": ["published"]
  },
  "repositories": ["chen362/Xautojs-devspace"],
  "branches": ["Xautojs-devspace"],
  "workflow": {
    "id": "github-pr-review",
    "permissionProfile": "workspace_write",
    "workspace": {
      "rootLabel": "xautojs-main",
      "mode": "worktree"
    }
  }
}
```

Dispatch flow:

```text
GitHub webhook accepted
  -> automation_event status=accepted
  -> automation_run status=queued
  -> dispatcher claims queued run
  -> resolves source workflow config
  -> resolves workspace policy and workspace session/worktree
  -> creates agent_run
  -> streams agent_run_events
  -> updates automation_run terminal status/result
```

Ignored events should remain audit-only and must not create native agent runs.

## 6. Updated Implementation Sequence

Completed:

```text
PR17: Automation ingress plan
PR18: Postgres automation event/run store
PR19: Generic API trigger endpoint
PR20: Automation source token management CLI
PR21: GitHub webhook receiver
PR22: GitHub webhook policy/routing
PR23: Owner-token OAuth SQLite persistence and SQLite hardening
```

Recommended next PRs:

```text
PR24: Native Agent Core Store And Contract
  Add agent_runs and agent_run_events migrations.
  Add TypeScript types and store methods.
  Add status transition validation.
  Add cursor-based event append/read tests.
  Do not run real agent work yet.

PR25: Native Agent Dispatcher And Process Engine
  Claim queued automation_runs safely.
  Create agent_runs from automation source workflow config.
  Implement local process lifecycle with start/read/write/cancel/timeout.
  Persist output deltas as agent_run_events.
  Keep the first engine first-party, not Codex/Claude backed.

PR26: Native Tool Policy And Approval Layer
  Add permission profiles.
  Classify read/write/edit/shell/network risk.
  Gate destructive/open-world operations.
  Store permission requests and decisions as run events.

PR27: Native Workflow Packs
  Add first-party workflows for github-pr-review, feature-dev, security-review, test-fix.
  Absorb Claude Code workflow organization ideas without depending on Claude Code.
  Make workflows selectable from automation source config.

PR28: Runtime Hooks
  Add internal hook events for PreToolUse, PostToolUse, PermissionRequest, and PostCompact/Stop.
  Allow audit-only and blocking hooks according to policy.
  Keep hooks typed and owner-scoped.

PR29: Operator UX
  Add CLI/API inspection for automation runs and native agent runs.
  Support retry, cancel, and event tailing.
  Add docs for GitHub source setup and workflow mapping.
```

Keep every PR independently shippable. The storage and contract PR should land
before execution. The execution PR should land before workflow packs. Workflow
packs should not be allowed to bypass policy.

## 7. Acceptance Criteria For The Native Agent Line

The next phase is ready when:

```text
Queued automation runs can be claimed exactly once.
Each claimed run creates a native agent_run.
Agent run events are durable and cursor-readable.
A caller can read output using afterSeq/nextSeq.
A caller can cancel a running agent_run.
Timeouts produce stable timed_out terminal state.
Permission decisions are recorded and replayable.
Tool calls are audited with sanitized inputs/results.
GitHub routable events can start configured native workflows.
Ignored GitHub events remain audit-only.
No Codex or Claude Code binary is required for the core runtime.
Codex/Claude-inspired features are reimplemented as Xautojs-native contracts.
```

## 8. Remaining Non-Goals

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

These can be revisited later only after the native Xautojs runtime is stable.
