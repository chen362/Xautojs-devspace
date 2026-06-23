# Xautojs Desktop

Xautojs Desktop is the local-first operator shell for the native agent runtime.
It connects to the local operator daemon introduced by PR39 and keeps the daemon
as the only backend trust boundary.

## Current Scaffold

Implemented in this scaffold:

```text
Tauri 2 + React app shell
loopback daemon URL input
in-memory operator token input
health and readiness checks
runs list from /api/native-agent/runs
selected run replay from /api/native-agent/runs/:agentRunId/replay
clear states for daemon unavailable, schema not ready, token missing, token rejected, and no runs
```

Not implemented yet:

```text
OS keychain session storage
pairing code flow
SSE live replay subscription
approve / deny / resume / retry / cancel actions
desktop notifications
packaged installers
```

## Run The Daemon

From the repository root, build and start the local operator daemon:

```bash
npm run build

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN="replace-with-a-long-random-token" \
node dist/cli.js operator serve
```

The default daemon URL is:

```text
http://127.0.0.1:7677
```

## Run The Desktop Shell

From `apps/desktop`:

```bash
npm install
npm run tauri:dev
```

For web-only UI iteration without the native window:

```bash
npm install
npm run dev
```

From the repository root, the CI-safe checks are:

```bash
npm run desktop:typecheck
npm run desktop:test
npm run desktop:build
```

## Security Notes

The scaffold intentionally does not store the raw operator token in
`localStorage`. The daemon URL can be remembered, but the token stays in renderer
memory for the current window only. Keychain-backed local sessions and pairing
codes belong in the later auth polish PR.

The local daemon allows CORS only for loopback development origins and Tauri
local origins. It does not expose `/mcp` from `operator serve`.
