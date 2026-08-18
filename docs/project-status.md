# Xautojs DevSpace Project Status

Updated: 2026-08-18

This document summarizes the current state of the repository using capabilities and changes that are already present in the codebase, documentation, CI, and merged pull requests.

## Current Position

Xautojs DevSpace is an early-stage open-source project focused on local-first AI coding infrastructure:

- self-hosted MCP workspace access
- native local agent execution
- GitHub automation ingress
- durable agent runs and replayable event history
- approval and policy gates
- runtime hooks
- operator CLI and browser console
- Xautojs Desktop operator surface

The project is MIT licensed and is maintained as a public GitHub repository.

## Completed Engineering Lines

### 1. Identity, Authentication, and Production Boundaries

Implemented:

- local owner-token authentication
- OIDC bearer-token verification for production mode
- tenant/user identity derivation
- owner-scoped MCP sessions and workspace access
- explicit SQLite vs Postgres deployment boundaries
- production fail-fast requirements for OIDC + Postgres

Representative history: PR #1, PR #2, PR #3, PR #4.

### 2. Durable Workspace and Postgres Support

Implemented:

- Postgres-backed workspace sessions
- owner-scoped session lookup and touch operations
- versioned Postgres migrations
- migration status and migration CLI commands
- production readiness checks
- optional real Postgres integration tests
- workspace session lifecycle cleanup
- persisted loaded `AGENTS.md` / `CLAUDE.md` file state

Representative history: PR #5 through PR #16.

### 3. Automation and GitHub Webhooks

Implemented:

- automation source and event storage
- idempotent automation trigger handling
- source token creation/list/rotation CLI
- GitHub webhook HMAC verification
- GitHub delivery deduplication
- event/repository/branch routing policy
- audit-only handling for ignored webhook events

Representative history: PR #17 through PR #23.

### 4. Native Agent Runtime

Implemented:

- Postgres-backed native agent runs and events
- local process execution without a shell dependency for first-party workflows
- command policy and permission profiles
- approval pause/resume
- event-sourced approval state
- retry, replay, dispatch, and cancellation
- built-in workflow packs
- typed runtime hooks
- execution plans and lifecycle/step events
- operator-focused replay summaries

Representative history: PR #24 through PR #29.

### 5. Operator Console and Local Operator Daemon

Implemented:

- operator API under `/api/native-agent`
- bearer-token authentication
- signed browser operator sessions
- `/operator` browser console
- run queue and status inspection
- replay timeline
- approval resolution
- hook decision visibility
- workflow step state
- resume, retry, cancel, and dispatch controls
- local operator daemon with loopback binding
- SSE replay stream for local clients

Representative history: PR #34 and PR #39.

### 6. Xautojs Desktop

Implemented as an operator surface:

- Tauri 2 + React desktop application shell
- local operator daemon connection
- replay inspection and live stream handling
- approve/deny, resume, retry, cancel, and dispatch actions
- keychain-backed desktop credential handling work
- macOS, Windows, and Linux bundle targets
- manual desktop artifact workflow
- cross-platform desktop packaging smoke tests
- checksum generation and GitHub artifact provenance

The desktop application is active development. Production code signing, notarization, signed release installers, and updater channels remain deferred release gates.

Representative history: PR #40 through PR #43 and subsequent Desktop maintenance commits.

## Engineering and Maintenance Signals

The repository uses a structured development workflow with:

- focused implementation pull requests
- explicit contract and scope sections in PR descriptions
- automated typecheck, tests, build, and platform smoke coverage
- Postgres integration coverage
- release packaging guardrails
- security-focused documentation
- reproducible desktop packaging checks
- MIT licensing

These are project-maintenance practices, not claims about community adoption. Public adoption metrics such as stars, forks, downloads, and external contributors are intentionally not inferred here.

## Current Release State

The package identity is:

```text
xautojs-devspace
```

The current package version is:

```text
1.0.1
```

The installed CLI binary remains:

```text
devspace
```

See [Release Packaging](release-packaging.md) and the [v1.0.1 Release Notes](releases/v1.0.1.md) for the release contract and current release notes.

## Next Work

The current roadmap continues to focus on making the project easier to operate and release as an open-source AI coding runtime:

- stabilize and document Desktop release workflows
- complete production signing/notarization gates before signed installers are claimed as stable
- keep operator APIs and workflow contracts backward-compatible where practical
- expand security and negative-path regression coverage
- improve first-run setup and contributor experience
- publish clear release artifacts and upgrade guidance

Roadmap items are intentionally listed as future work unless they are already implemented in the repository.
