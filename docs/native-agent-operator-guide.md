# Native Agent Operator Guide

This guide is a practical runbook for operating Xautojs native agent runs from a
source checkout.

The examples assume:

```bash
npm install --include=dev
npm run build
```

Run CLI commands from the repository root with `node dist/cli.js ...`. A future
global package can expose the same commands through the `devspace` binary.

## 1. Prepare Postgres

Native agent operator workflows require Postgres-backed state and ready
migrations.

```bash
export DEVSPACE_DATABASE_PROVIDER="postgres"
export DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace"
export DEVSPACE_POSTGRES_SSL_MODE="disable"

node dist/cli.js db migrate
node dist/cli.js db status --json
```

The schema is ready when `db status --json` reports:

```json
{
  "ready": true,
  "state": "ready"
}
```

## 2. Configure Operator API Auth

The CLI talks to Postgres directly and does not require an operator token. The
HTTP operator API and browser console require one:

```bash
export DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN="replace-with-a-long-random-token"
```

For browser sessions, production deployments should also set a separate session
secret and an explicit TTL:

```bash
export DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET="replace-with-a-long-random-session-secret"
export DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS="28800"
```

Start the server with the same database and token environment:

```bash
node dist/cli.js serve
```

HTTP API requests may include:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

The browser console exchanges the same token for a signed HttpOnly session
cookie. The token is not stored in local storage.

Example bearer request:

```bash
curl -fsS \
  -H "Authorization: Bearer $DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" \
  http://127.0.0.1:7676/api/native-agent/runs
```

## 3. Use The Operator Console

Open the console from the same DevSpace origin:

```text
http://127.0.0.1:7676/operator
```

For production, use your public HTTPS origin:

```text
https://devspace.example.com/operator
```

The console is the recommended remote and fallback operator surface. It shows:

```text
run queue and status filters
replay timeline
approval state
hook decisions
workflow step state
retry links
run actions
manual dispatch
```

Main browser loop:

```text
login with operator token
select a run
inspect replay summary and timeline
approve or deny pending approvals
resume waiting runs
retry terminal runs
cancel stale work
dispatch queued automation when needed
```

For the full browser workflow and production smoke commands, see
[Native Agent Operator Console](native-agent-operator-console.md).

## 4. Inspect Available Workflows

```bash
node dist/cli.js agent workflows
```

Built-in workflows:

```text
manual
github-pr-review
feature-dev
security-review
test-fix
```

Workflow packs define the operator-visible execution plan. Each step has a
phase, action, expected output, acceptance criteria, and suggested tools.

## 5. Dispatch Work

### Claim The Oldest Queued Automation Run

```bash
node dist/cli.js agent dispatch-once --workspace-root /path/to/workspace
```

### Claim A Specific Automation Run

```bash
node dist/cli.js agent dispatch-once \
  --automation-run-id <automationRunId> \
  --workspace-root /path/to/workspace
```

### Dispatch A Queued Native Run Directly

Use this for retry-created native runs, waiting runs, or future manually created
native runs:

```bash
node dist/cli.js agent dispatch-run \
  --id <agentRunId> \
  --workspace-root /path/to/workspace
```

Dispatch and resume support:

```bash
--timeout-ms <ms>
--approval-timeout-ms <ms>
```

## 6. List And Inspect Runs

List recent native agent runs:

```bash
node dist/cli.js agent list
```

Filter by status:

```bash
node dist/cli.js agent list --status waiting_input
```

Read raw events:

```bash
node dist/cli.js agent events --id <agentRunId>
node dist/cli.js agent events --id <agentRunId> --after-seq 20 --max-events 100
```

Replay a run with the operator summary:

```bash
node dist/cli.js agent replay --id <agentRunId>
```

Use JSON when an integration needs the full event stream:

```bash
node dist/cli.js agent replay --id <agentRunId> --json
```

The replay response contains:

```text
events[]
approvals[]
nextSeq
terminal
summary
```

Important summary fields:

```text
summary.status
summary.approvals.pending / approved / denied / total
summary.approvals.latestPending
summary.hooks.allow / ask / block / deny / auditOnly / total
summary.hooks.blocking[]
summary.hooks.latest[]
summary.workflowSteps[]
summary.retries.retryOfAgentRunId
summary.retries.retryAgentRunIds[]
```

## 7. Handle Approvals

A run that requires approval moves to `waiting_input` and records a pending
approval.

List approvals:

```bash
node dist/cli.js agent approvals --id <agentRunId>
```

Approve:

```bash
node dist/cli.js agent approve \
  --id <agentRunId> \
  --approval-id <approvalId> \
  --message "Approved by operator."
```

Deny:

```bash
node dist/cli.js agent deny \
  --id <agentRunId> \
  --approval-id <approvalId> \
  --message "Denied by operator."
```

Resume after approval:

```bash
node dist/cli.js agent resume \
  --id <agentRunId> \
  --workspace-root /path/to/workspace
```

Approval request/resolution events are stored as:

```text
run.approval.requested
run.approval.resolved
run.approval.accepted
run.resumed
```

Equivalent approval requests are matched by a stable fingerprint so repeated
dispatch/resume attempts reuse the existing pending approval rather than creating
duplicates.

## 8. Retry Terminal Runs

Retries are allowed only from terminal native runs.

Create a retry:

```bash
node dist/cli.js agent retry \
  --id <agentRunId> \
  --reason "Retry after fixing local environment."
```

Then dispatch the returned retry run:

```bash
node dist/cli.js agent dispatch-run \
  --id <retryAgentRunId> \
  --workspace-root /path/to/workspace
```

Replay shows retry links in:

```text
summary.retries.retryOfAgentRunId
summary.retries.retryAgentRunIds[]
```

The event stream records:

```text
run.retry.created
run.retry.source
```

## 9. Cancel Runs

Cancel a running or queued native run:

```bash
node dist/cli.js agent cancel \
  --id <agentRunId> \
  --reason "Operator cancelled stale run."
```

Cancellation is reflected in run status and replay events.

## 10. Configure Runtime Hooks

Runtime hook rules are configured with `DEVSPACE_NATIVE_RUNTIME_HOOKS`.

Example:

```bash
export DEVSPACE_NATIVE_RUNTIME_HOOKS='{
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
}'
```

Hook events:

```text
Start
WorkflowStep
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

Every hook decision is replayable from `agent_run_events` as:

```text
run.hook.decision
```

`agent_runtime_hooks` stores only this legacy subset:

```text
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

Use replay for `Start` and `WorkflowStep` decisions. They intentionally do not
write to `agent_runtime_hooks` because the current Postgres table constraint only
accepts the legacy subset.

## 11. Quick Operator Loop

Recommended browser loop:

```text
open /operator
select waiting_input or running runs
inspect replay summary
resolve approvals
resume, retry, cancel, or dispatch as needed
```

A compact CLI loop remains useful for scripts and terminal-only debugging:

```bash
node dist/cli.js agent dispatch-once --workspace-root /path/to/workspace
node dist/cli.js agent list
node dist/cli.js agent replay --id <agentRunId>
node dist/cli.js agent approvals --id <agentRunId>
node dist/cli.js agent approve --id <agentRunId> --approval-id <approvalId>
node dist/cli.js agent resume --id <agentRunId> --workspace-root /path/to/workspace
node dist/cli.js agent replay --id <agentRunId>
```

For automation, prefer `--json` and consume `nextSeq`, `terminal`, and
`summary` from replay.

## 12. Desktop Operator Direction

The browser console remains the remote and fallback operator surface. The planned
Xautojs Desktop app is the local-first default surface for daily operator work.

Desktop should connect to a loopback operator daemon, reuse the same
`/api/native-agent` contract, and expose the current replay, approval, hook,
workflow-step, resume, retry, cancel, and dispatch controls without requiring the
operator to open a browser.

The planned local daemon entry point is:

```bash
node dist/cli.js operator serve
```

Future global install equivalent:

```bash
devspace operator serve
```

For the full desktop product architecture, daemon contract, Tauri plan,
permission UX, streaming model, and PR roadmap, see
[Xautojs Desktop Operator Architecture](xautojs-desktop-operator.md).
