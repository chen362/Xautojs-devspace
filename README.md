<p align="center">
  <img src="docs/assets/devspace-logo-light.png" alt="Xautojs DevSpace" width="140">
</p>

<h1 align="center">Xautojs DevSpace</h1>

<p align="center">
  <strong>A self-hosted MCP workspace and native agent runtime for local-first AI coding.</strong>
</p>

<p align="center">
  Connect ChatGPT-compatible MCP clients to selected local workspaces, run auditable agent workflows, and operate GitHub-driven automation from your own machine.
</p>

<p align="center">
  <a href="README-cn.md">中文</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="docs/project-status.md">Project Status</a> ·
  <a href="docs/setup.md">Documentation</a> ·
  <a href="docs/releases/v1.0.1.md">v1.0.1 Release Notes</a> ·
  <a href="docs/native-agent-runtime.md">Native Agent Runtime</a> ·
  <a href="docs/security.md">Security Model</a>
</p>

<p align="center">
  <img alt="Package" src="https://img.shields.io/badge/package-xautojs--devspace-blue?style=flat-square" />
  <a href="https://github.com/chen362/Xautojs-devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/chen362/Xautojs-devspace/ci.yml?style=flat-square&branch=main" /></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](docs/assets/devspace-screenshot.png)](docs/assets/devspace-screenshot.png)

## Why Xautojs DevSpace?

AI coding agents are powerful, but local development still needs a controlled bridge between an AI client, the developer's workspace, and the tools that actually execute code.

**Xautojs DevSpace provides that bridge.** It is designed as local-first infrastructure for AI-assisted development and OSS maintenance: the MCP layer exposes explicitly approved workspaces, while the native runtime turns automation into observable, permission-aware, and replayable agent runs.

### Core capabilities

- **MCP workspace bridge** — open approved local project roots and let an MCP-capable client read, edit, search, and inspect code.
- **Native local agent runtime** — execute coding workflows locally without requiring a Codex or Claude Code binary.
- **GitHub automation** — receive verified GitHub webhooks and turn repository events into owner-scoped automation work.
- **Auditable execution** — persist agent runs, events, tool calls, approvals, and runtime hook decisions.
- **Permission and approval controls** — pause execution for human approval, then resume, retry, cancel, or replay runs.
- **Workflow packs** — built-in workflows include `github-pr-review`, `feature-dev`, `security-review`, and `test-fix`.
- **Operator surfaces** — CLI, browser console, and Xautojs Desktop expose the same operator API for local and remote administration.
- **Project-aware instructions** — load `AGENTS.md`, `CLAUDE.md`, and local skills so workflows follow repository-specific rules.

## Built for AI-assisted OSS maintenance

Xautojs DevSpace is especially useful when an open-source project needs more than an AI chat window:

```text
GitHub event
    ↓
Webhook verification & routing
    ↓
Automation trigger
    ↓
Native agent workflow
    ↓
Tools / tests / git / local workspace
    ↓
Approval & policy gates
    ↓
Auditable run events
    ↓
Replay / retry / operator review
```

This makes workflows such as **PR review, security review, test fixing, and feature development** first-class runtime concepts rather than one-off scripts.

The project is intentionally self-hosted and local-first. Your workspace, runtime state, execution policy, and operator controls can remain under your control.

## What makes it different

Xautojs DevSpace takes inspiration from modern AI coding-agent workflows, but the runtime itself is Xautojs-native:

- no Codex or Claude Code binary is required
- workspace access is explicitly scoped
- automation state can be backed by Postgres
- GitHub webhook signatures are verified before routing
- agent execution is represented as durable, inspectable events
- approval and hook decisions are part of the execution history
- runs can be replayed, retried, resumed, or cancelled

The goal is not to replace an AI model. The goal is to provide the **local execution, policy, automation, and operator layer around AI coding workflows**.

## Quick Start

Requirements: Node `>=22.19 <27`. Node 22 LTS is recommended.

```bash
git clone https://github.com/chen362/Xautojs-devspace.git
cd Xautojs-devspace
npm install --include=dev
npm run build

node dist/cli.js init
node dist/cli.js serve
```

During initialization, DevSpace asks which local project folders the MCP client may access and configures the local server. For remote ChatGPT-compatible connections, expose the server through your HTTPS tunnel or reverse proxy and use:

```text
https://your-tunnel-host.example.com/mcp
```

See the [Setup Guide](docs/setup.md) for the complete configuration and security model.

## Architecture at a glance

```text
┌───────────────────────────────┐
│ ChatGPT / MCP-capable client  │
└───────────────┬───────────────┘
                │ MCP
                ▼
┌───────────────────────────────┐
│ Xautojs DevSpace               │
│                               │
│ Workspace Bridge              │
│ Automation & GitHub Webhooks  │
│ Native Agent Runtime          │
│ Policy / Approval / Hooks     │
│ Operator API / Console / CLI  │
└───────────────┬───────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
 Local Workspaces     Postgres
```

For production deployments, Postgres is used for workspace, automation, and native-agent state. SQLite remains available for local development and simple single-user setups.

## Documentation

- [中文 README](README-cn.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Project Status & Roadmap](docs/project-status.md)
- [Setup Guide](docs/setup.md)
- [v1.0.1 Release Notes](docs/releases/v1.0.1.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Security Model](docs/security.md)
- [Native Agent Runtime](docs/native-agent-runtime.md)
- [Native Agent Operator Guide](docs/native-agent-operator-guide.md)
- [Native Agent Operator Console](docs/native-agent-operator-console.md)
- [Release Packaging](docs/release-packaging.md)
- [Production Smoke Check](docs/production-smoke.md)
- [Xautojs Desktop Operator Architecture](docs/xautojs-desktop-operator.md)
- [Xautojs Desktop Packaging](docs/xautojs-desktop-packaging.md)

## Development

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

Postgres integration tests can be run with:

```bash
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

## Platform Support

Linux and macOS are fully supported. Windows is supported with Git Bash, WSL, MSYS2, or Cygwin Bash; pure PowerShell/cmd-only shell workflows have limited compatibility.

## License

MIT.