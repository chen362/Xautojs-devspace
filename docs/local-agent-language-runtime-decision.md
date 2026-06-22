# Language And Runtime Decision

This file is a companion addendum for `docs/local-agent-capability-absorption-plan.md` until the main plan can be patched through a full local checkout or a line-level GitHub edit path.

The content below should be inserted into `docs/local-agent-capability-absorption-plan.md` immediately after the `## 0. Executive Decision` section and before `## 1. Conversation And Session Model`.

## 0.1 Language And Runtime Decision

DevSpace should keep TypeScript as the primary implementation language.

Current baseline:

```text
primary language:
  TypeScript

runtime:
  Node.js

frontend:
  React + Vite + TypeScript

current package/build style:
  npm scripts
  TypeScript compiler
  Vite build
  dist/ output
```

Hard language decisions:

```text
Primary product language is TypeScript.
Primary runtime is Node.js.
Frontend workbench remains React + Vite + TypeScript.
Cloud MCP gateway, API gateway, relay, auth boundary, tool contracts, and context memory should be implemented in TypeScript.
Production storage uses Postgres.
SQLite is allowed only through a dev/test adapter.
Local DevSpace Agent v1 should also be TypeScript + Node.js so it can share contracts, schemas, and runtime event types with the cloud gateway.
Rust is allowed later only as an optional native sidecar for local performance or security-critical capabilities.
```

Do not rewrite DevSpace into Rust, Go, or Python for v1.

Reasoning:

```text
DevSpace is already a TypeScript project.
The MCP SDK, Apps SDK integration path, Zod schemas, React UI, Vite build, and existing server code fit TypeScript naturally.
Shared TypeScript contracts reduce drift between MCP tools, relay envelopes, local agent events, UI event cards, and database payloads.
GitHub Actions can compile and test the project directly with npm.
```

Future Rust sidecar candidates:

```text
high-performance file scanning
PTY/process isolation
local sandbox enforcement
patch/diff acceleration
single-binary local packaging
secure local credential helpers
filesystem watchers
```

Rust sidecars must communicate with the TypeScript runtime through explicit typed protocols. They must not become the primary product architecture for v1.

## Build And CI Decision

GitHub should be able to build the TypeScript project directly.

Recommended first CI shape:

```text
npm ci
npm run typecheck
npm test
npm run build
```

Recommended Node target:

```text
Use Node 24 for the main CI lane because the current runtime already supports it.
Keep package engine compatibility broad enough for the current project policy, such as >=20.12 <27, unless a dependency forces a narrower range.
```

Do not introduce a second primary build system before the cloud relay, Postgres boundary, context memory, and local agent runtime are stable.
