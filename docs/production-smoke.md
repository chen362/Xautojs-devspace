# Production Smoke Check

This guide verifies a production-style DevSpace deployment before you put real
MCP traffic or native agent operator work on it. It is written for Ubuntu/Linux,
macOS, and Windows.

The commands below assume a source checkout that has already run:

```bash
npm install --include=dev
npm run build
```

Run CLI commands from the repository root with `node dist/cli.js ...`. If you
install a future published package globally, the equivalent binary remains
`devspace`.

## What This Checks

- production config loads with OIDC + Postgres
- Postgres migration status is readable as JSON
- migrations can be applied safely
- `devspace doctor` reports Postgres schema readiness
- the server can start after schema readiness passes
- `/healthz` returns process liveness
- `/readyz` returns runtime readiness with Postgres schema status
- `/operator` serves the bundled native agent operator console
- operator session cookie auth works without storing the token in the browser
- `/api/native-agent/runs` is reachable through the operator session cookie

## Requirements

All platforms need:

- Node `>=20.12 <27`; Node 22 LTS is recommended
- npm
- Git
- a Bash-compatible shell available to DevSpace
- network access to the Postgres database
- network access to the public HTTPS origin or reverse proxy

Windows support requires Git Bash, WSL, MSYS2, or Cygwin Bash for DevSpace shell
execution. PowerShell can still be used to set environment variables and run the
smoke commands.

Install the optional Postgres driver in the same environment that runs DevSpace:

```bash
npm install pg
```

For source-checkout deployments, install `pg` in the repository checkout before
running the production smoke.

## Environment Template

Use `examples/production.env.example` as the source of truth for variable names.
Do not commit real secrets.

Minimum production variables:

```text
DEVSPACE_DEPLOYMENT_MODE=production
DEVSPACE_AUTH_MODE=oidc
DEVSPACE_OIDC_ISSUER=https://auth.example.com
DEVSPACE_OIDC_AUDIENCE=https://devspace.example.com/mcp
DEVSPACE_DATABASE_PROVIDER=postgres
DEVSPACE_DATABASE_URL=postgres://devspace:replace-me@db.example.com:5432/devspace
DEVSPACE_POSTGRES_SSL_MODE=require
DEVSPACE_PUBLIC_BASE_URL=https://devspace.example.com
DEVSPACE_ALLOWED_ROOTS=/srv/devspace/workspaces
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN=replace-with-long-random-operator-token
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET=replace-with-long-random-session-secret
DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS=28800
```

`DEVSPACE_DATABASE_URL` is redacted in doctor output. Keep the real value in your
secret manager, service config, or local shell only.

`DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN` is accepted by CLI-style bearer API
clients and by the `/operator` login screen. The browser exchanges it for a
signed HttpOnly session cookie. In production, keep
`DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET` separate from the operator token.

## Ubuntu / Linux And macOS

Use Bash or zsh:

```bash
export DEVSPACE_DEPLOYMENT_MODE="production"
export DEVSPACE_AUTH_MODE="oidc"
export DEVSPACE_OIDC_ISSUER="https://auth.example.com"
export DEVSPACE_OIDC_AUDIENCE="https://devspace.example.com/mcp"
export DEVSPACE_DATABASE_PROVIDER="postgres"
export DEVSPACE_DATABASE_URL="postgres://devspace:replace-me@db.example.com:5432/devspace"
export DEVSPACE_POSTGRES_SSL_MODE="require"
export DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com"
export DEVSPACE_ALLOWED_HOSTS="devspace.example.com"
export DEVSPACE_ALLOWED_ROOTS="$HOME/devspace-workspaces"
export DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN="replace-with-long-random-operator-token"
export DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET="replace-with-long-random-session-secret"
export DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS="28800"

node dist/cli.js db status --json
node dist/cli.js db migrate
node dist/cli.js db status --json
node dist/cli.js doctor --json
node dist/cli.js serve
```

## Windows PowerShell

Use PowerShell for environment variables. DevSpace still needs Git Bash, WSL,
MSYS2, or Cygwin Bash installed for workspace shell execution.

```powershell
$env:DEVSPACE_DEPLOYMENT_MODE = "production"
$env:DEVSPACE_AUTH_MODE = "oidc"
$env:DEVSPACE_OIDC_ISSUER = "https://auth.example.com"
$env:DEVSPACE_OIDC_AUDIENCE = "https://devspace.example.com/mcp"
$env:DEVSPACE_DATABASE_PROVIDER = "postgres"
$env:DEVSPACE_DATABASE_URL = "postgres://devspace:replace-me@db.example.com:5432/devspace"
$env:DEVSPACE_POSTGRES_SSL_MODE = "require"
$env:DEVSPACE_PUBLIC_BASE_URL = "https://devspace.example.com"
$env:DEVSPACE_ALLOWED_HOSTS = "devspace.example.com"
$env:DEVSPACE_ALLOWED_ROOTS = "$HOME\devspace-workspaces"
$env:DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN = "replace-with-long-random-operator-token"
$env:DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET = "replace-with-long-random-session-secret"
$env:DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS = "28800"

node dist/cli.js db status --json
node dist/cli.js db migrate
node dist/cli.js db status --json
node dist/cli.js doctor --json
node dist/cli.js serve
```

## Windows Git Bash Or WSL

Use the Linux/macOS commands. Prefer POSIX-style paths for `DEVSPACE_ALLOWED_ROOTS`:

```bash
export DEVSPACE_ALLOWED_ROOTS="$HOME/devspace-workspaces"
```

For Git Bash native Windows paths, quote them carefully:

```bash
export DEVSPACE_ALLOWED_ROOTS="C:\\Users\\alice\\devspace-workspaces"
```

## Expected `db status --json`

Before migration, a new database usually reports `missing` or `pending`:

```json
{
  "state": "missing",
  "ready": false,
  "tableExists": false,
  "pendingCount": 1,
  "modifiedCount": 0
}
```

After `devspace db migrate`, status should report:

```json
{
  "state": "ready",
  "ready": true,
  "tableExists": true,
  "pendingCount": 0,
  "modifiedCount": 0
}
```

The real output includes `migrationsDir`, `tableName`, `appliedCount`, and the
full `migrations` array.

## Expected `doctor --json`

A healthy production smoke should have:

```json
{
  "ok": true,
  "config": {
    "status": "ok",
    "deploymentMode": "production",
    "authMode": "oidc",
    "database": {
      "provider": "postgres"
    }
  },
  "postgresSchema": {
    "state": "ready",
    "ready": true,
    "pendingCount": 0,
    "modifiedCount": 0
  }
}
```

If `postgresSchema.state` is `missing`, `pending`, or `modified`, run
`devspace db migrate` or investigate the modified migration before serving
traffic. If it is `error`, fix the connection, `pg` dependency, credentials, SSL
mode, or database permissions first.

## Serve Readiness

`devspace serve` performs the same Postgres schema readiness gate before it
accepts traffic. The server should only start when:

- production mode uses OIDC auth
- production mode uses Postgres
- `devspace_schema_migrations` exists
- no packaged migration is pending
- no applied migration checksum differs from the packaged SQL

A failed serve exits with a migration hint instead of accepting requests with an
unknown schema.

## Runtime Probe Endpoints

After `devspace serve` starts, deployment platforms can probe the process and
runtime readiness over the same public origin.

Ubuntu/Linux and macOS:

```bash
curl -fsS https://devspace.example.com/healthz
curl -fsS https://devspace.example.com/readyz
```

Windows PowerShell:

```powershell
Invoke-RestMethod https://devspace.example.com/healthz
Invoke-RestMethod https://devspace.example.com/readyz
```

`/healthz` is a liveness probe and returns HTTP 200 when the process can respond.
`/readyz` is a readiness probe. It returns HTTP 200 with `status: "ready"` when
checks pass, and HTTP 503 with `status: "not_ready"` when Postgres schema status
is missing, pending, modified, or unreadable.

In Postgres mode, `/readyz` includes the same migration readiness shape used by
`db status --json`. It does not include the raw database URL.

## Operator Console Smoke

The operator console is served at `/operator`. It depends on the Vite build
manifest and assets generated by `npm run build`.

Ubuntu/Linux and macOS:

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

Windows PowerShell:

```powershell
Invoke-WebRequest https://devspace.example.com/operator -UseBasicParsing

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod `
  -Method Post `
  -WebSession $session `
  -ContentType "application/json" `
  -Body (@{ token = $env:DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN } | ConvertTo-Json) `
  https://devspace.example.com/api/native-agent/operator/session

Invoke-RestMethod -WebSession $session https://devspace.example.com/api/native-agent/operator/session
Invoke-RestMethod -WebSession $session https://devspace.example.com/api/native-agent/runs
```

Expected results:

- `/operator` returns HTML for the native agent operator console.
- `POST /api/native-agent/operator/session` returns HTTP 201 and sets a session cookie.
- `GET /api/native-agent/operator/session` returns `authenticated: true`.
- `GET /api/native-agent/runs` returns HTTP 200 with a `runs` array when Postgres schema readiness is green.

## Smoke Checklist

- `node dist/cli.js db status --json` returns valid JSON.
- `state` becomes `ready` after `node dist/cli.js db migrate`.
- `node dist/cli.js doctor --json` returns `ok: true`.
- `postgresSchema.ready` is `true`.
- `database.url` in doctor output is redacted.
- `node dist/cli.js serve` starts and prints the public `/mcp` URL.
- `/healthz` returns HTTP 200.
- `/readyz` returns HTTP 200 with `status: "ready"`.
- `/operator` returns the bundled operator console HTML.
- `POST /api/native-agent/operator/session` accepts the operator token and returns a session cookie.
- `/api/native-agent/runs` returns HTTP 200 when called with the operator session cookie.
