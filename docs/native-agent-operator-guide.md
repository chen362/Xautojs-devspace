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
HTTP operator API requires one:

```bash
export DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN="replace-with-a-long-random-token"
```

Start the server with the same database and token environment:

```bash
node dist/cli.js serve
```

HTTP requests must include:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Example:

```bash
curl -fsS \
  -H "Authorization: Bearer $DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" \
  http://127.0.0.1:7676/api/native-agent/runs
```

## 3. Inspect Available Workflows

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

## 4. Dispatch Work

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

## 5. List And Inspect Runs

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

## 6. Handle Approvals

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

## 7. Retry Terminal Runs

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

## 8. Cancel Runs

Cancel a running or queued native run:

```bash
node dist/cli.js agent cancel \
  --id <agentRunId> \
  --reason "Operator cancelled stale run."
```

Cancellation is reflected in run status and replay events.

## 9. Configure Runtime Hooks

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

## 10. Quick Operator Loop

A compact day-to-day loop:

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
