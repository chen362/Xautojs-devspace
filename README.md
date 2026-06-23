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
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/chen362/Xautojs-devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/chen362/Xautojs-devspace/ci.yml?style=flat-square&branch=Xautojs-devspace" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
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

The Xautojs branch also adds production-oriented automation and native agent
execution:

- Postgres-backed workspace, automation, and native agent state
- generic automation triggers and GitHub webhook ingress
- GitHub webhook signature verification and routing policy
- first-party native agent runs, events, process execution, and workflow packs
- permission profiles, approval pause/resume, runtime hooks, retry, replay, and
  operator APIs
- operator CLI commands for dispatch, replay, approvals, retry, and cancel

Codex and Claude Code are reference systems for good ideas. The runtime, storage,
policy, hooks, workflow packs, and operator controls are Xautojs-native and do
not require a Codex or Claude Code binary.

## Package Note

This repository currently keeps the upstream CLI package name:

```bash
@waishnav/devspace
```

The default development branch is:

```text
Xautojs-devspace
```

Use the default branch documentation as the source of truth for the Xautojs
runtime features.

## Quick Start

DevSpace requires Node `>=20.12 <27`. Node 22 LTS is recommended.

Install the CLI:

```bash
npm install -g @waishnav/devspace
```

Initialize and start the server:

```bash
devspace init
devspace serve
```

Or run it without a global install:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
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
the Owner password printed by `devspace init`. It is also stored in:

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
2. Run `devspace serve`.
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
npx @waishnav/devspace db migrate
```

Check schema readiness with JSON output:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
npx @waishnav/devspace db status --json
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
devspace automation source create
devspace automation source list
devspace automation source rotate-token
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

Native agent commands require Postgres. Operator HTTP APIs additionally require:

```text
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN
```

Common CLI flow:

```bash
devspace agent workflows
devspace agent dispatch-once --workspace-root /path/to/workspace
devspace agent list
devspace agent replay --id <agentRunId>
devspace agent approvals --id <agentRunId>
devspace agent approve --id <agentRunId> --approval-id <approvalId>
devspace agent deny --id <agentRunId> --approval-id <approvalId>
devspace agent resume --id <agentRunId> --workspace-root /path/to/workspace
devspace agent retry --id <agentRunId>
devspace agent cancel --id <agentRunId>
```

`devspace agent replay --id <agentRunId>` now prints an operator-focused summary
by default: status, workflow, approval counts, hook decision counts, workflow
step state, pending approval, blocking hooks, and retry links. Use `--json` for
the full machine-readable event stream.

## Operator API

The native agent operator API is mounted under:

```text
/api/native-agent
```

It requires:

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

Important endpoints:

```text
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
devspace doctor
```

## Documentation

- [中文 README](README-cn.md)
- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Production Smoke Check](docs/production-smoke.md)
- [DevSpace Automation Ingress Plan](docs/devspace-automation-ingress-plan.md)
- [Native Agent Runtime](docs/native-agent-runtime.md)
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
