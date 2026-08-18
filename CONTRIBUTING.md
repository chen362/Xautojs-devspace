# Contributing to Xautojs DevSpace

Thank you for contributing to Xautojs DevSpace.

Xautojs DevSpace is a self-hosted MCP workspace and native agent runtime for local-first AI coding and OSS maintenance. The project values small, reviewable changes, explicit contracts, tests, and reproducible CI verification.

## Before You Start

For larger changes, open an issue first so the proposed behavior and scope can be discussed before implementation. For small fixes, a focused pull request is usually sufficient.

Please read:

- [Security Model](docs/security.md)
- [Release Packaging](docs/release-packaging.md)
- [Native Agent Runtime](docs/native-agent-runtime.md)
- [Project Status](docs/project-status.md)

## Development Setup

Requirements:

- Node.js `>=22.19 <27`
- Node 22 LTS is recommended
- Git

Clone and install:

```bash
git clone https://github.com/chen362/Xautojs-devspace.git
cd Xautojs-devspace
npm install --include=dev
```

## Local Verification

Before opening a pull request, run the checks relevant to your change:

```bash
npm run typecheck
npm test
npm run build
```

For Postgres-specific changes, also run:

```bash
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

The repository CI also exercises cross-platform smoke coverage and the Postgres integration path.

## Pull Requests

Keep pull requests focused on one coherent change. A useful pull request description should explain:

1. What changed and why.
2. The runtime/API/CLI contract affected by the change.
3. Tests and verification performed.
4. Any compatibility, migration, security, or release implications.
5. Follow-up work that is intentionally out of scope.

For behavior changes, include examples or contract snippets where they make the change easier to review.

Do not include secrets, access tokens, private keys, local database URLs, or personal workspace data in commits, tests, screenshots, or issue reports.

## Commit Guidance

Use clear, action-oriented commit messages. Examples:

```text
feat: add native agent workflow checkpointing
docs: clarify operator authentication
fix: reject cross-owner workspace session reuse
test: cover GitHub webhook idempotency
```

## Security-Sensitive Changes

Changes involving authentication, authorization, workspace boundaries, command execution, webhook verification, token handling, secrets, or native process execution deserve extra scrutiny.

When changing these areas:

- preserve owner/tenant isolation boundaries
- keep secrets out of persistent logs and source control
- prefer explicit policy checks over implicit trust
- add regression tests for negative and failure paths
- document externally visible security behavior

For a suspected vulnerability that should not be disclosed publicly, use the repository's private security reporting channel rather than opening a public issue with exploit details.

## Documentation

User-visible behavior should be documented with the code change. Keep the English README and Chinese README aligned when the project-level behavior or setup instructions change.

Architecture and operator changes should update the relevant document under `docs/`.

## Review Standard

A contribution is ready when it is:

- scoped and understandable
- covered by appropriate tests
- compatible with the documented runtime contracts
- documented when user-facing
- free of secrets and unrelated changes

Maintainers may request changes when a contribution weakens security boundaries, breaks compatibility without a migration path, or lacks sufficient verification.

## License

By contributing, you agree that your contributions are provided under the repository's [MIT License](LICENSE).