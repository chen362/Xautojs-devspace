# Xautojs Desktop

Xautojs Desktop is the local-first operator shell for the native agent runtime.
It connects to the local operator daemon introduced by PR39 and keeps the daemon
as the only backend trust boundary.

## Current MVP

Implemented now:

```text
Tauri 2 + React app shell
loopback daemon URL input
in-memory operator token input
health and readiness checks
runs list from /api/native-agent/runs
selected run replay from /api/native-agent/runs/:agentRunId/replay
live replay through /api/native-agent/runs/:agentRunId/stream
polling fallback when the stream is unavailable
clear states for daemon unavailable, schema not ready, token missing, token rejected, and no runs
dispatch once
approve pending approval
deny pending approval
resume selected run
retry selected run
cancel selected run
hook decision cards from replay.summary.hooks
workflow step state from replay.summary.workflowSteps
Tauri bundle configuration for macOS, Windows, and Linux artifacts
generated app icons for PNG, ICO, and ICNS targets
SHA256 checksum generation for bundle outputs
GitHub artifact provenance attestation in packaging workflows
```

Still intentionally deferred:

```text
OS keychain session storage
pairing code flow
desktop notifications
signed production installers
auto-updater channels
remembered approval policy edits
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

## Package Desktop Artifacts

The root npm package remains CLI-first; desktop installers are separate release
artifacts.

Generate icons only:

```bash
npm --prefix apps/desktop run icons:generate
```

Build the current platform bundle from the repository root:

```bash
npm --prefix apps/desktop install --package-lock-only --ignore-scripts
npm --prefix apps/desktop ci
npm run desktop:bundle
npm --prefix apps/desktop run artifacts:checksums
```

After `apps/desktop/package-lock.json` is committed, use:

```bash
npm --prefix apps/desktop ci
npm run desktop:bundle
npm --prefix apps/desktop run artifacts:checksums
```

Platform-specific bundle commands:

```bash
npm --prefix apps/desktop run bundle:macos
npm --prefix apps/desktop run bundle:windows
npm --prefix apps/desktop run bundle:linux
```

The manual GitHub artifact workflow is:

```text
.github/workflows/desktop-release.yml
```

The PR packaging smoke runs from:

```text
.github/workflows/ci.yml -> desktop-artifact-smoke
```

Artifacts are uploaded from:

```text
apps/desktop/src-tauri/target/release/bundle/**/*
```

The workflows also upload generated lockfiles from:

```text
apps/desktop/package-lock.json
apps/desktop/src-tauri/Cargo.lock
```

These artifacts are unsigned smoke or release-candidate artifacts until platform
signing, lockfiles, checksums, provenance, and updater policy are all production-ready.

## Operator Flow

1. Start `node dist/cli.js operator serve` with Postgres ready.
2. Open Xautojs Desktop.
3. Confirm daemon URL, usually `http://127.0.0.1:7677`.
4. Enter the same token configured as `DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN`.
5. Dispatch a run or select an existing run.
6. Use the inspector to approve, deny, resume, retry, cancel, and inspect hooks or workflow steps.

Live replay uses the SSE stream with an Authorization header via `fetch`. If the
stream fails, the UI falls back to periodic replay polling so the selected run
remains usable.

## Security Notes

The desktop MVP intentionally does not store the raw operator token in
`localStorage`. The daemon URL can be remembered, but the token stays in renderer
memory for the current window only. Keychain-backed local sessions and pairing
codes belong in the later auth polish PR.

The local daemon allows CORS only for loopback development origins and Tauri
local origins. It does not expose `/mcp` from `operator serve`.
