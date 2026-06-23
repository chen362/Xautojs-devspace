# Local Operator Daemon

The local operator daemon is the desktop-facing native agent operator server. It
runs only the operator health/readiness surface and `/api/native-agent` routes;
it does not expose the MCP `/mcp` endpoint.

Use it as the backend for Xautojs Desktop and other local-first operator clients.
The browser `/operator` console remains available from the full `devspace serve`
path for remote, admin, CI, and fallback operations.

## Command

From a source checkout:

```bash
node dist/cli.js operator serve
```

Future global package equivalent:

```bash
devspace operator serve
```

Default daemon binding:

```text
host: 127.0.0.1
port: 7677
base URL: http://127.0.0.1:7677
operator API: http://127.0.0.1:7677/api/native-agent
readiness: http://127.0.0.1:7677/readyz
```

## Requirements

The daemon is intentionally stricter than `devspace serve` because native agent
operator workflows require durable Postgres state.

Required before startup:

```text
DEVSPACE_DATABASE_PROVIDER=postgres
DEVSPACE_DATABASE_URL=postgres://...
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN=...
Postgres migrations ready
```

Prepare the database:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
node dist/cli.js db migrate
```

Start the daemon:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN="replace-with-a-long-random-token" \
node dist/cli.js operator serve
```

The daemon checks Postgres schema readiness before listening. If migrations are
missing, pending, or modified, startup fails with the same migration guidance as
the production server.

## Flags

```text
--host <host>
  Bind host. Defaults to 127.0.0.1.

--port <port>
  Bind port. Defaults to 7677.

--database-url <postgres-url>
  Sets DEVSPACE_DATABASE_PROVIDER=postgres and DEVSPACE_DATABASE_URL for this run.

--postgres-ssl-mode <prefer|require|disable>
  Overrides DEVSPACE_POSTGRES_SSL_MODE for this run.

--operator-token <token>
  Overrides DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN for this run.

--session-ttl-seconds <seconds>
  Overrides DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS for this run.
  Minimum 60 seconds.

--json
  Prints daemon metadata as JSON after startup.
```

Example with flags:

```bash
node dist/cli.js operator serve \
  --database-url "postgres://devspace:secret@127.0.0.1:5432/devspace" \
  --postgres-ssl-mode disable \
  --operator-token "replace-with-a-long-random-token" \
  --json
```

## Exposed Routes

The local daemon exposes:

```text
GET  /healthz
GET  /readyz
POST /api/native-agent/operator/session
GET  /api/native-agent/operator/session
DELETE /api/native-agent/operator/session
GET  /api/native-agent/runs
GET  /api/native-agent/runs/:agentRunId
GET  /api/native-agent/runs/:agentRunId/events
GET  /api/native-agent/runs/:agentRunId/replay
GET  /api/native-agent/runs/:agentRunId/stream
GET  /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals/:approvalId/resolve
POST /api/native-agent/runs/:agentRunId/resume
POST /api/native-agent/runs/:agentRunId/retry
POST /api/native-agent/runs/:agentRunId/cancel
POST /api/native-agent/dispatch/once
POST /api/native-agent/dispatch/run
```

It does not expose:

```text
/mcp
```

## Replay Stream

Desktop clients should prefer the SSE replay stream when available and fall back
to polling `/replay` or `/events` when SSE is unavailable.

Endpoint:

```text
GET /api/native-agent/runs/:agentRunId/stream?afterSeq=<number>&pollMs=<ms>&maxEvents=<number>
```

Query parameters:

```text
afterSeq:
  Cursor position. Defaults to 0.

pollMs:
  Internal store polling interval. Defaults to 1000.
  Values are clamped to 50..30000.

maxEvents:
  Max events to read per poll. Defaults to 100.
```

Authentication is the same as the rest of the operator API:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

SSE event names:

```text
replay.snapshot
run.event
approval.pending
approval.resolved
hook.decision
workflow.step
run.terminal
heartbeat
error
```

Initial `replay.snapshot` payload:

```json
{
  "agentRunId": "agent_run_...",
  "events": [],
  "approvals": [],
  "summary": {},
  "nextSeq": 1,
  "terminal": false,
  "requestId": "..."
}
```

Delta event payload:

```json
{
  "agentRunId": "agent_run_...",
  "event": {
    "seq": 2,
    "type": "run.loop.step",
    "payload": {}
  },
  "summary": {},
  "nextSeq": 3,
  "terminal": false,
  "requestId": "..."
}
```

Reconnect rule:

```text
Reconnect with afterSeq set to the last observed nextSeq - 1.
```

If a stream ends after `run.terminal`, the client should stop reconnecting unless
the operator explicitly retries or reopens the run.

## Smoke Checks

```bash
curl -fsS http://127.0.0.1:7677/healthz
curl -fsS http://127.0.0.1:7677/readyz
curl -fsS \
  -H "Authorization: Bearer $DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" \
  http://127.0.0.1:7677/api/native-agent/runs
```

For one selected run:

```bash
curl -N \
  -H "Authorization: Bearer $DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" \
  "http://127.0.0.1:7677/api/native-agent/runs/<agentRunId>/stream?afterSeq=0"
```
