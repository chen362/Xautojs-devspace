# Native Agent Operator Console

The native agent operator console is a browser UI for day-to-day run operations.
It is served by the DevSpace server at:

```text
/operator
```

Use it when an operator needs to inspect native agent runs, replay event state,
resolve approvals, review hook decisions, monitor workflow steps, resume paused
runs, retry terminal runs, cancel stale work, or dispatch queued automation.

## Requirements

The console uses the same native agent backend as the operator API and CLI.
Before opening it, make sure the server has:

```text
DEVSPACE_DATABASE_PROVIDER=postgres
DEVSPACE_DATABASE_URL=postgres://...
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN=...
```

The Postgres schema must be ready:

```bash
node dist/cli.js db migrate
node dist/cli.js db status --json
```

The UI assets are bundled by the normal build:

```bash
npm run build
node dist/cli.js serve
```

If `/operator` returns a 503 about missing assets, run `npm run build` in the
same checkout or deployment image before starting the server.

## Authentication

The console does not store the operator token in local storage. Instead, the
first login exchanges the token for a signed HttpOnly session cookie.

Session endpoints:

```text
POST   /api/native-agent/operator/session
GET    /api/native-agent/operator/session
DELETE /api/native-agent/operator/session
```

`POST /api/native-agent/operator/session` accepts either a JSON token body or the
existing bearer header:

```json
{
  "token": "replace-with-operator-token"
}
```

A successful login returns:

```json
{
  "session": {
    "authenticated": true,
    "method": "session",
    "expiresAt": "2026-06-23T12:00:00.000Z"
  },
  "requestId": "..."
}
```

After login, the browser sends the session cookie automatically. CLI, curl, and
other integrations can continue using:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

## Session Configuration

Recommended production variables:

```text
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN=replace-with-long-random-operator-token
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET=replace-with-long-random-session-secret
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS=28800
```

`DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET` signs the browser session cookie.
If it is unset, DevSpace falls back to the operator token so local deployments
keep working, but production should use a separate secret.

`DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS` defaults to 8 hours. Values
below 60 seconds are clamped to 60 seconds.

When `DEVSPACE_PUBLIC_BASE_URL` uses HTTPS, the session cookie is marked secure.
Production deployments should serve `/operator` only through HTTPS.

## What Operators See

The console is designed around three panes:

- run queue and status filters
- replay timeline with events, approvals, hooks, and workflow transitions
- run inspector with summary, pending approval, workflow steps, and actions

The summary is powered by `replay.summary`:

```text
summary.status
summary.approvals
summary.hooks
summary.workflowSteps
summary.retries
```

This keeps the UI aligned with the CLI replay output and avoids forcing
operators to interpret raw event JSON for normal decisions.

## Main Workflow

1. Open `/operator` on the DevSpace origin.
2. Enter `DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN` once.
3. Review the run list and select a run.
4. Inspect replay status, pending approvals, hook decisions, workflow steps, and retry links.
5. Approve or deny the latest pending approval.
6. Resume a waiting run after approval.
7. Retry failed, cancelled, timed out, or succeeded terminal runs when needed.
8. Cancel stale queued, claiming, running, or waiting runs when needed.
9. Dispatch queued automation with `dispatch-once` from the console when an operator wants manual control.

## Empty, Error, And Token States

The UI exposes common operator states directly:

- missing token: login screen explains that the operator token is required
- invalid token: login remains on screen and shows the API error
- empty run list: queue view shows an empty state instead of a blank page
- pending approval: inspector promotes the latest pending approval with approve/deny buttons
- blocking hook: summary highlights `ask`, `block`, and `deny` hook decisions
- API failure: the last API error is shown in the console header area and the previous data remains visible when possible

## Hook Decision Visibility

Every runtime hook decision is written to the replay event stream as:

```text
run.hook.decision
```

`agent_runtime_hooks` intentionally stores only the legacy hook event subset:

```text
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

`Start` and `WorkflowStep` decisions are visible through replay and the console,
but they are not written to `agent_runtime_hooks` because the current Postgres
migration keeps that table constrained to the legacy subset.

## Production Smoke

After a production build and server start, smoke the console session path:

```bash
curl -fsS https://devspace.example.com/operator | grep -q "Operator Console"

curl -fsS -c /tmp/devspace-operator.cookies \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN\"}" \
  https://devspace.example.com/api/native-agent/operator/session

curl -fsS -b /tmp/devspace-operator.cookies \
  https://devspace.example.com/api/native-agent/operator/session

curl -fsS -b /tmp/devspace-operator.cookies \
  https://devspace.example.com/api/native-agent/runs
```

A healthy console path returns HTML, creates a session cookie, confirms the
session, and can list native agent runs once Postgres readiness is green.

## Reverse Proxy And OIDC

The main MCP surface can still use production OIDC (`DEVSPACE_AUTH_MODE=oidc`).
The operator console uses the native agent operator token to mint a scoped
operator session cookie because native agent operator roles are not yet mapped
from OIDC claims.

If a deployment already has an enterprise identity proxy, put `/operator` and
`/api/native-agent/*` behind that proxy as an additional access layer, but keep
`DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN` enabled. The backend treats the session
cookie and bearer token as the stable operator API contract.
