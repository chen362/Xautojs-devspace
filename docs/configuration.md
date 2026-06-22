# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace doctor --json
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
npx @waishnav/devspace db status
npx @waishnav/devspace db status --json
npx @waishnav/devspace db migrate
npx @waishnav/devspace db migrate --json
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

SQLite is the default local database provider. Postgres mode is intended for
production deployments and requires the schema in `migrations/postgres` to be
applied before serving traffic.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_DATABASE_PROVIDER` | `sqlite` | Set to `postgres` to use Postgres-backed workspace sessions. |
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
npx @waishnav/devspace db status

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
npx @waishnav/devspace db status --json

DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
npx @waishnav/devspace db migrate
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
npx @waishnav/devspace doctor --json
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
npx @waishnav/devspace serve
```

Example:

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="require" \
npx @waishnav/devspace serve
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
npx @waishnav/devspace serve
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
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
