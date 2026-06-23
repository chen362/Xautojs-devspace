<p align="center">
  <picture>
    <img src="docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">Xautojs DevSpace</h1>

<p align="center">A self-hosted MCP workspace bridge and native local agent runtime for ChatGPT.</p>

<p align="center">
  English | <a href="README-cn.md">中文</a>
</p>

<p align="center">
  <img alt="Package" src="https://img.shields.io/badge/package-xautojs--devspace-blue?style=flat-square" />
  <a href="https://github.com/chen362/Xautojs-devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/chen362/Xautojs-devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](docs/assets/devspace-screenshot.png)](docs/assets/devspace-screenshot.png)

## What This Project Is

Xautojs DevSpace starts from DevSpace's local MCP workspace model and extends it
into an independent native local agent runtime.

It lets ChatGPT or another MCP-capable host work with selected local project
folders through explicit tools, while keeping execution on your machine:

- open approved local workspaces
- read, write, edit, search, and inspect project files
- run local commands for tests, builds, git, and package scripts
- use isolated Git worktrees for parallel coding sessions
- load project instructions from `AGENTS.md` and `CLAUDE.md`
- discover local agent skills
- expose change widgets in ChatGPT Apps-compatible hosts

The Xautojs project also adds production-oriented automation and native agent
execution:

- Postgres-backed workspace, automation, and native agent state
- generic automation triggers and GitHub webhook ingress
- GitHub webhook signature verification and routing policy
- first-party native agent runs, events, process execution, and workflow packs
- permission profiles, approval pause/resume, runtime hooks, retry, replay, and
  operator APIs
- browser operator console for run replay, approvals, hook decisions, workflow
  step state, dispatch, resume, retry, and cancel
- operator CLI commands for dispatch, replay, approvals, retry, and cancel
- Xautojs Desktop operator for a local-first Codex/Claude-style workspace,
  approval, replay, workflow UI, and desktop release artifact path

Codex and Claude Code are reference systems for good ideas. The runtime, storage,
policy, hooks, workflow packs, and operator controls are Xautojs-native and do
not require a Codex or Claude Code binary.

## Package And CLI Contract

Xautojs DevSpace is moving off the upstream package identity. The release-facing
package identity is:

```text
xautojs-devspace
```

Do not publish new releases as:

```text
@waishnav/devspace
```

The installed CLI binary remains:

```text
devspace
```

The package name and executable are intentionally different: users install the
Xautojs package identity, while existing config, scripts, and docs can continue
using the `devspace` command. Source-checkout docs use `node dist/cli.js ...`
until a public npm release exists.

The default development branch is:

```text
main
```

Before publishing, `package.json`, `package-lock.json`, badges, and release docs
must all agree on `xautojs-devspace`. See [Release Packaging](docs/release-packaging.md)
for the pre-publish checklist and CLI compatibility rules.

Until a public npm release is published under the new package name, use the
source checkout workflow below.

## Quick Start From Source

DevSpace requires Node `>=20.12 <27`. Node 22 LTS is recommended.

Clone and build this repository:

```bash
git clone https://github.com/chen362/Xautojs-devspace.git
cd Xautojs-devspace
git checkout main
npm install --include=dev
npm run build
```

Initialize and start the server from the built CLI:

```bash
node dist/cli.js init
node dist/cli.js serve
```

During setup, DevSpace asks for:

- the local project folders ChatGPT is allowed to open
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale
  Funnel, or another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

Configure your MCP client with the public `/mcp` URL:

```text
https://your-tunnel-host.example.com/mcp
```

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `node dist/cli.js init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. A connected MCP client can still have
powerful local capabilities inside an opened workspace, including shell
execution. Treat a connected client like a trusted coding partner with access to
that part of your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `node dist/cli.js serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open one of your allowed project folders.

## Production Postgres

SQLite remains the default for local use. Postgres is required for production
workspace state, automation ingress, and native agent operator workflows.

Run migrations before serving production traffic:

```bash
DEVSPACE_DEPLOYMENT_MODE="production" \
DEVSPACE_AUTH_MODE="oidc" \
DEVSPACE_OIDC_ISSUER="https://auth.example.com" \
DEVSPACE_OIDC_AUDIENCE="https://devspace.example.com/mcp" \
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="require" \
node dist/cli.js db migrate
```

Check schema readiness with JSON output:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db status --json
```

Then start the server with the same database settings. `devspace serve` checks
that migrations are current before accepting traffic. Runtime probes are
available at `/healthz` for liveness and `/readyz` for readiness.

## Automation Ingress

Automation sources are owner-scoped and Postgres-backed. Supported ingress paths
include:

```text
POST /api/automation/triggers/:triggerId/fire
POST /api/automation/github/webhooks/:sourceId
```

The GitHub webhook path verifies `X-Hub-Signature-256`, deduplicates deliveries,
applies source routing policy, and either queues automation work or stores the
event as audit-only ignored work.

Source tokens are managed with:

```bash
node dist/cli.js automation source create
node dist/cli.js automation source list
node dist/cli.js automation source rotate-token
```

## Native Agent Runtime

The native runtime turns queued automation work into auditable local execution.
It provides:

```text
agent_runs
agent_run_events
agent_tool_calls
agent_runtime_hooks
```

Native run status is more detailed than coarse automation status:

```text
queued -> claiming -> running -> waiting_input -> succeeded | failed | cancelled | timed_out
```

Built-in workflow packs include:

```text
manual
github-pr-review
feature-dev
security-review
test-fix
```

Runtime hooks are typed and replayable:

```text
Start
WorkflowStep
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

Every hook decision is mirrored into the run event stream as
`run.hook.decision`, so operator replay can show lifecycle and workflow-step
state. Legacy hook table records are still kept for `PreToolUse`, `PostToolUse`,
`PermissionRequest`, `PostCompact`, and `Stop`.

## Operator CLI

Native agent commands require Postgres. Operator HTTP APIs and the browser
console additionally require:

```text
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN
```

Recommended browser session settings:

```text
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS
```

Common CLI flow:

```bash
node dist/cli.js agent workflows
node dist/cli.js agent dispatch-once --workspace-root /path/to/workspace
node dist/cli.js agent list
node dist/cli.js agent replay --id <agentRunId>
node dist/cli.js agent approvals --id <agentRunId>
node dist/cli.js agent approve --id <agentRunId> --approval-id <approvalId>
node dist/cli.js agent deny --id <agentRunId> --approval-id <approvalId>
node dist/cli.js agent resume --id <agentRunId> --workspace-root /path/to/workspace
node dist/cli.js agent retry --id <agentRunId>
node dist/cli.js agent cancel --id <agentRunId>
```

`node dist/cli.js agent replay --id <agentRunId>` now prints an operator-focused
summary by default: status, workflow, approval counts, hook decision counts,
workflow step state, pending approval, blocking hooks, and retry links. Use
`--json` for the full machine-readable event stream.

## Operator Console

The browser console is served from the DevSpace server at:

```text
/operator
```

It lets an operator inspect runs without reading raw JSON:

```text
run queue and status filters
replay timeline
approval approve/deny
hook decision visibility
workflow step state
resume, retry, cancel
dispatch queued automation
```

The console login exchanges `DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN` for a signed
HttpOnly session cookie. Bearer token auth remains supported for CLI, curl, and
scripts.

See [Native Agent Operator Console](docs/native-agent-operator-console.md) for
setup, session configuration, UI workflow, and production smoke commands.

## Xautojs Desktop Direction

Xautojs Desktop is the local-first default interface for daily native-agent work.
It is a Tauri desktop app that connects to the local loopback operator daemon,
shows live replay, exposes approvals and run controls, and packages separately
from the CLI npm package.

Current desktop packaging state:

```text
Tauri app shell and operator MVP are implemented
local daemon connection, replay stream, actions, hook cards, and workflow cards are implemented
app icon generation is built into the desktop package scripts
macOS, Windows, and Linux bundle targets are configured
manual GitHub artifact workflow exists for unsigned smoke and release-candidate builds
signed production installers and updater channels are still deferred
```

The browser `/operator` console remains the remote, admin, CI, and fallback
surface. Desktop uses a local loopback daemon and the same operator API contract
instead of reading Postgres directly.

See [Xautojs Desktop Operator Architecture](docs/xautojs-desktop-operator.md) for
the daemon contract, Tauri app plan, permission UX, streaming model, roadmap, and
acceptance criteria. See [Xautojs Desktop Packaging](docs/xautojs-desktop-packaging.md)
for installer targets, signing placeholders, release artifacts, and updater policy.

## Operator API

The native agent operator API is mounted under:

```text
/api/native-agent
```

It accepts either a bearer token or the operator session cookie created by
`/api/native-agent/operator/session`:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Important endpoints:

```text
POST /api/native-agent/operator/session
GET  /api/native-agent/operator/session
DELETE /api/native-agent/operator/session
GET  /api/native-agent/runs
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

See [Native Agent Runtime](docs/native-agent-runtime.md) for the full contract.

## Platform Support

DevSpace supports Linux, macOS, and Windows environments.

| Platform | Status | Notes |
| --- | --- | --- |
| Linux | Supported | Requires Node, npm, Git, and Bash for MCP shell workflows. |
| macOS | Supported | Requires Node, npm, Git, and Bash for MCP shell workflows. |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | Supported | Git Bash is the simplest native Windows setup. |
| Windows PowerShell or `cmd.exe` only | Partial | The native agent process engine avoids shell assumptions, but MCP shell workflows still expect a Bash-compatible shell. |

Run this to inspect your local setup:

```bash
node dist/cli.js doctor
```

## Documentation

- [中文 README](README-cn.md)
- [Setup Guide](docs/setup.md)
- [Release Packaging](docs/release-packaging.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Production Smoke Check](docs/production-smoke.md)
- [DevSpace Automation Ingress Plan](docs/devspace-automation-ingress-plan.md)
- [Cloud MCP Gateway Architecture](docs/xautojs-cloud-mcp-gateway.md)
- [Native Agent Runtime](docs/native-agent-runtime.md)
- [Native Agent Operator Guide](docs/native-agent-operator-guide.md)
- [Native Agent Operator Console](docs/native-agent-operator-console.md)
- [Xautojs Desktop Operator Architecture](docs/xautojs-desktop-operator.md)
- [Xautojs Desktop Packaging](docs/xautojs-desktop-packaging.md)
- [Security Model](docs/security.md)
- [Troubleshooting Gotchas](docs/gotchas.md)

## Local Development

For working on this repository:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

Run the Postgres integration test when a database is available:

```bash
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

## License

MIT.
