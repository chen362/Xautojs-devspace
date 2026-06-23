# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The examples below assume a source checkout that has already run `npm run build`.
Use `node dist/cli.js ...` from the repository root. If you install a future
published package globally, the equivalent binary remains `devspace`.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config node dist/cli.js serve
```

## Commands

```bash
node dist/cli.js init
node dist/cli.js serve
node dist/cli.js doctor
node dist/cli.js doctor --json
node dist/cli.js config get
node dist/cli.js config set publicBaseUrl https://devspace.example.com
node dist/cli.js db status
node dist/cli.js db status --json
node dist/cli.js db migrate
node dist/cli.js db migrate --json
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_WORKSPACE_SESSION_TTL_SECONDS` | Optional age limit for workspace sessions based on `last_used_at`. When unset, sessions are not automatically expired. |
| `DEVSPACE_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS` | Background cleanup interval when session TTL is enabled. Defaults to `3600`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |

## Database

SQLite is the default local database provider. Postgres mode is required for
production deployments, automation sources/events/runs, and native agent
operator workflows.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_DATABASE_PROVIDER` | `sqlite` | Set to `postgres` to use Postgres-backed workspace, automation, and native agent state. |
| `DEVSPACE_DATABASE_URL` | unset | Required when `DEVSPACE_DATABASE_PROVIDER=postgres`. |
| `DEVSPACE_POSTGRES_SSL_MODE` | `prefer` | One of `prefer`, `require`, or `disable`. |

Postgres mode uses the optional `pg` peer dependency. Install it in the same
runtime environment as DevSpace when enabling Postgres:

```bash
npm install pg
```

The migration runner stores applied versions in `devspace_schema_migrations`.
Use `status` to inspect pending or modified migrations, and `migrate` to apply
pending files in lexical order:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db status

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db status --json

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db migrate
```

`devspace db status --json` returns a stable machine-readable object with
`state`, `ready`, `tableExists`, migration counts, and the migration list. The
state is one of `ready`, `missing`, `pending`, or `modified`.

For real Postgres regression coverage in a development checkout, install the
optional `pg` peer dependency and provide a test database URL:

```bash
npm install pg
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

`npm run test:postgres` creates a temporary schema, runs the packaged Postgres
migrations there, verifies `PostgresWorkspaceStore` create/read/touch/cleanup
behavior, and drops the schema before exit. It skips cleanly when
`DEVSPACE_DATABASE_URL` is not set. CI also runs this test against a temporary
Postgres service on Ubuntu.

`devspace doctor` reports the Postgres schema state when Postgres mode is active.
Use JSON output for deployment smoke checks:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js doctor --json
```

`devspace serve` checks the Postgres schema before starting and exits with a
migration hint if the schema version table is missing, a migration is pending,
or an applied migration checksum no longer matches the packaged SQL file.

Workspace sessions and loaded AGENTS/CLAUDE file snapshots are stored in the
database. `loaded_agent_files` rows cascade when their workspace session is
deleted. To enable automatic session expiry in long-running deployments, set a
TTL and optionally tune the cleanup interval:

```bash
DEVSPACE_WORKSPACE_SESSION_TTL_SECONDS="2592000" \
DEVSPACE_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS="3600" \
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js serve
```

Example:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="require" \
node dist/cli.js serve
```

For a full Ubuntu/Linux, macOS, and Windows production smoke flow, see
[Production Smoke Check](production-smoke.md). `examples/production.env.example`
contains a copyable environment template.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Native Agent Operator

Native agent operator workflows require Postgres mode and ready migrations. At a
minimum, prepare the database before dispatching or replaying native runs:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db migrate

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js db status --json
```

Operator HTTP APIs require a bearer token:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN` | Bearer token required by `/api/native-agent/*` routes. |
| `DEVSPACE_NATIVE_RUNTIME_HOOKS` | Optional JSON runtime hook rule config. |

CLI commands run locally and do not use `DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN`.
They still require `DEVSPACE_DATABASE_PROVIDER=postgres`, `DEVSPACE_DATABASE_URL`,
and a ready schema because they access the native agent store directly.

Common CLI checks:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js agent workflows

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js agent list

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
node dist/cli.js agent replay --id <agentRunId>
```

Operator API example:

```bash
curl -fsS \
  -H "Authorization: Bearer $DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN" \
  https://devspace.example.com/api/native-agent/runs/<agentRunId>/replay
```

`DEVSPACE_NATIVE_RUNTIME_HOOKS` is a JSON object. Example:

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

Hook decisions are replayable through `agent_run_events` as
`run.hook.decision`. The legacy `agent_runtime_hooks` table stores only
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PostCompact`, and `Stop`.
Use replay for `Start` and `WorkflowStep` decisions.

## Tool Modes

`DEVSPACE_TOOL_NAMING` controls tool names.

| Value | Behavior |
| --- | --- |
| `short` | Default. Uses `read`, `edit`, `bash`, and related names. |
| `legacy` | Uses `read_file`, `edit_file`, `run_shell`, and related names. |

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Disables dedicated search and list tools. Clients use the shell tool with `rg`, `grep`, `find`, `ls`, or `tree` for inspection. |
| `full` | Enables dedicated `grep`, `glob`, and `ls` tools. |

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated skill directories. |

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.codex/skills,$HOME/.claude/skills" \
node dist/cli.js serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_TOOL_NAMING="short" \
DEVSPACE_WIDGETS="full" \
node dist/cli.js serve
```

The environment assignments must be part of the same command invocation, or
exported first.
