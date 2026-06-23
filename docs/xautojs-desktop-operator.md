# Xautojs Desktop Operator Architecture

Last updated: 2026-06-23

## Product Decision

Xautojs should have a local desktop operator as the default day-to-day surface.
The existing browser `/operator` console remains valuable, but it should become
the remote, admin, CI, and fallback console rather than the primary local UX.

Target split:

```text
Xautojs Desktop:
  local-first operator UX for daily work
  project/workspace navigation
  chat-style run creation and follow-up
  approval prompts
  hook decision visibility
  workflow step state
  run replay and retry controls

Browser /operator:
  remote operator console
  server/admin fallback
  production smoke surface
  CI or headless debugging surface
```

The desktop app must not turn Xautojs into a wrapper around Codex or Claude Code.
Codex and Claude Desktop are references for UX quality. Xautojs owns the runtime,
policy, storage, hooks, workflow packs, approvals, replay model, and operator
contracts.

## Recommended Stack

Use Tauri 2 + React for the desktop application.

Reasons:

```text
native-feeling local app without the Electron weight
small installer and memory footprint
Rust sidecar bridge for OS integration when needed
system notifications, tray, deep links, and keychain access
frontend can reuse the existing React operator UI patterns
backend can reuse the existing native agent operator API
```

Do not choose Electron for the first desktop line unless the product explicitly
needs a VS Code-scale extension host, heavy embedded terminal model, or Chromium-
first plugin ecosystem. Xautojs currently benefits more from a lean local shell
around a strong daemon contract.

## Target Architecture

```text
Xautojs Desktop (Tauri + React)
  -> local operator daemon on 127.0.0.1
    -> native agent operator API
    -> native agent runtime
    -> Postgres-backed runs/events/approvals/hooks/workflows
    -> workspace roots and first-party process engine
```

The desktop app must never access Postgres directly. It talks only to the local
operator daemon over the same stable HTTP contract that the browser console and
operator integrations use.

The local daemon is the trust boundary:

```text
process ownership
workspace root enforcement
operator authentication
policy and hook evaluation
approval request and resolution
run dispatch/resume/retry/cancel
replay summary and event streaming
```

## Local Daemon Contract

Planned command:

```bash
node dist/cli.js operator serve
```

Future global install equivalent:

```bash
devspace operator serve
```

Default daemon rules:

```text
bind host: 127.0.0.1
bind port: 7677 unless overridden
remote bind: disabled by default
operator API prefix: /api/native-agent
browser console: optional, not opened by default in desktop mode
Postgres readiness: required before accepting operator traffic
```

Recommended flags for PR39:

```text
--host <host>
--port <port>
--database-url <url>
--postgres-ssl-mode <prefer|require|disable>
--operator-token <token>
--session-ttl-seconds <seconds>
--workspace-root <path>
--no-browser-console
--json
```

The daemon may be implemented by reusing the existing server internals, but the
CLI command should express operator-local intent. A user should not need to know
which server module happens to serve the API.

## Authentication And Pairing

The desktop app should avoid hand-entered long-lived tokens during normal local
use.

MVP pairing contract:

```text
1. daemon starts on loopback
2. daemon requires DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN or generates a local-only token
3. desktop opens a pairing screen when no valid session exists
4. desktop exchanges a token or one-time pairing code through the existing session endpoint
5. daemon returns a signed HttpOnly session cookie
6. Tauri stores only session metadata or refresh material in the OS keychain
7. the renderer never stores the raw operator token in localStorage
```

Existing session endpoint remains valid:

```text
POST   /api/native-agent/operator/session
GET    /api/native-agent/operator/session
DELETE /api/native-agent/operator/session
```

Desktop-specific pairing can be added later as an additive API:

```text
POST /api/native-agent/operator/desktop/pair
```

If added, it must be loopback-only, one-time, short-lived, and auditable.

## Existing Operator API Reuse

The desktop app should reuse the current operator endpoints first:

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

The key desktop data source is `replay.summary`:

```text
summary.status
summary.approvals
summary.hooks
summary.workflowSteps
summary.retries
```

The UI must not reconstruct normal operator state from raw event JSON when the
summary already exposes it.

## Streaming Contract

Desktop UX should feel live. PR39 should add a streaming API or formalize a
polling fallback.

Preferred additive endpoint:

```text
GET /api/native-agent/runs/:agentRunId/stream?afterSeq=<number>
```

Transport:

```text
SSE first
polling fallback through replay afterSeq/nextSeq
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
```

Every message should include:

```json
{
  "agentRunId": "...",
  "nextSeq": 42,
  "terminal": false,
  "summary": {}
}
```

`summary` can be omitted on high-frequency delta events, but `replay.snapshot`
and terminal events should include it. The desktop app must tolerate reconnects
by resuming from the last known `nextSeq`.

## Desktop Information Architecture

Use a three-pane operator workspace.

```text
left rail:
  projects / workspaces
  recent runs
  status filters
  pending approval count
  connection state

center workspace:
  chat-style run composer
  selected run transcript
  workflow timeline
  terminal/output drawer
  retry and resume context

right inspector:
  replay summary
  pending approval card
  hook decision cards
  workflow step checklist
  retry lineage
  raw event toggle for debugging
```

The first screen should be the working surface, not a marketing page. Empty
states should be operational:

```text
no daemon connected
Postgres schema not ready
operator token/session missing
no runs yet
no pending approvals
selected run terminal
selected run waiting_input
```

## Approval UX

Approval prompts should be desktop-native and interruptive enough to be useful
without becoming noisy.

Required states:

```text
ask every time
approve once
deny once
remember for this run
remember for this workspace policy later
open policy/config location
```

The first MVP may implement only approve/deny/resume through existing APIs. The
UI must still show where a future remembered decision would live, so the product
direction is clear.

Approval cards should display:

```text
risk
request title
request message
workflow id and step phase
command or operation preview when available
workspace root
hook rule id when caused by a hook
created time and timeout
```

## Permission UX

Permission presets should be presented in Xautojs language, not copied from any
other product.

Recommended labels:

```text
Ask every time
Workspace writes
Local trusted mode
Read only
Use project policy
```

Mapping to runtime policy:

```text
Read only -> read_only
Workspace writes -> workspace_write
Local trusted mode -> trusted_local
Use project policy -> selected workflow/source/workspace policy
Ask every time -> hook/policy rule that returns ask for risky operations
```

The desktop UI should show the active profile and whether it came from workflow,
source routing, workspace policy, or a temporary operator override.

## Visual And Interaction Direction

Visual thesis:

```text
quiet native command center: dense, calm, fast, and trustworthy
```

Interaction thesis:

```text
run state changes should feel live
approval prompts should be unmistakable
operator details should be one click away, never forced into the main flow
```

Design rules:

```text
no browser-looking admin dashboard as the default desktop surface
no marketing hero screen
no nested cards
no decorative gradients or mascot-first UI
compact typography and strong alignment
native window chrome and OS-level notifications
keyboard-first navigation for power users
```

Expected shortcuts:

```text
Cmd/Ctrl+K: command palette
Cmd/Ctrl+N: new run
Cmd/Ctrl+R: retry selected terminal run
Cmd/Ctrl+Enter: submit composer
Esc: close modal/drawer
```

## File And Package Layout

Proposed PR40 layout:

```text
apps/desktop/
  package.json
  src/
  src-tauri/
  index.html
  vite.config.ts
```

The root npm package should remain `xautojs-devspace`. Do not accidentally ship
desktop build artifacts inside the CLI npm package until release packaging is
explicitly designed for it.

Initial root-level packaging rule:

```text
CLI package publishes dist/docs/examples/migrations/scripts/readmes only.
Desktop installers are separate release artifacts.
```

## Implementation Roadmap

```text
PR38: Desktop UX and architecture spec
  Land this document and wire README/operator guide links.

PR39: Local operator daemon
  Add `operator serve`, loopback defaults, readiness checks, session handling,
  and a replay stream or documented polling fallback.

PR40: Tauri desktop scaffold
  Add apps/desktop with a connection screen, daemon status, and empty states.
  Do not duplicate runtime logic in the desktop app.

PR41: Desktop operator MVP
  Implement runs list, selected replay, pending approval, approve/deny, resume,
  retry, cancel, hook decisions, and workflow steps.

PR42: Desktop packaging
  Add macOS, Windows, and Linux packaging strategy, icons, app id, release
  artifacts, signing placeholders, and updater decision notes.

PR43: Desktop auth polish
  Add keychain-backed local sessions, pairing-code UX, OS notifications, and
  optional enterprise identity integration.
```

## Acceptance Criteria

The desktop line is ready for MVP use when:

```text
A user can start the local daemon without starting a browser-first workflow.
The desktop app can connect to loopback and show schema/session readiness.
The app can list runs and keep a selected run live through replay updates.
Pending approvals are visible without reading raw JSON.
Approve, deny, resume, retry, cancel, and dispatch actions call stable APIs.
Hook decisions and workflow step state are visible from replay.summary.
The renderer never stores raw operator tokens in localStorage.
The app has clear empty/error states for daemon down, schema not ready, and auth missing.
The browser /operator console remains usable as a remote fallback.
```

## Non-Goals For The First Desktop Line

```text
Replacing the browser /operator console
Direct database access from Tauri
Hard dependency on Codex CLI or Claude Code CLI
General remote execution outside allowed roots
Shipping a VS Code-like extension host
Publishing desktop artifacts inside the CLI npm package by accident
Enterprise OIDC claim mapping in the first scaffold
```
