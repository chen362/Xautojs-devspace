# Release Packaging

This document is the release contract for publishing Xautojs DevSpace as an
independent package. It keeps package identity, CLI naming, and npm release steps
consistent as the project moves away from the upstream DevSpace package name.

## Naming Contract

| Surface | Value | Notes |
| --- | --- | --- |
| GitHub repository | `chen362/Xautojs-devspace` | Public source repository. |
| Default branch | `Xautojs-devspace` | Release candidates branch from here. |
| npm package name | `xautojs-devspace` | Do not publish new releases as `@waishnav/devspace`. |
| Installed CLI binary | `devspace` | Kept for compatibility with existing config, scripts, and docs. |
| Source-checkout command | `node dist/cli.js ...` | Preferred in docs until a public npm release exists. |

The package name and the installed executable are intentionally different:
users install the Xautojs package identity, while existing CLI usage continues to
run through `devspace`.

If a future release adds a package-matching `xautojs-devspace` binary alias,
keep `devspace` as a compatibility alias unless a major-version migration guide
says otherwise.

## Metadata Requirements

Before publishing, verify these files agree on package identity:

- `package.json` top-level `name` is `xautojs-devspace`.
- `package-lock.json` top-level `name` is `xautojs-devspace`.
- `package-lock.json` root package entry `packages[""].name` is
  `xautojs-devspace`.
- README badges and install docs do not point to `@waishnav/devspace`.
- `repository`, `bugs`, and `homepage` in `package.json` point to
  `chen362/Xautojs-devspace`.

Do not publish if any release-facing metadata still identifies the package as
`@waishnav/devspace`.

## Versioning

Use semver:

- Patch: documentation, bug fixes, compatibility-preserving operator/runtime
  fixes.
- Minor: new runtime features, new operator endpoints, new workflow packs, or new
  config keys with compatible defaults.
- Major: breaking API contracts, CLI command removals, storage migration rules
  that require manual operator action, or dropping the `devspace` compatibility
  binary.

Version bumps should update both `package.json` and `package-lock.json`.

## Pre-Publish Checklist

Run from a clean checkout of `Xautojs-devspace`:

```bash
npm install --package-lock-only --include=dev
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

For production/operator changes, also run the Postgres integration test in an
environment with Postgres available:

```bash
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

Inspect the dry-run file list. It should include:

- `dist/`
- `docs/`
- `examples/`
- `migrations/`
- `scripts/`
- `README.md`
- `README-cn.md`

It should not rely on local-only files outside the `files` allowlist.

## Publish Command

Publish the public package only after the checklist passes:

```bash
npm publish --access public
```

After publishing, smoke test the package in a fresh directory:

```bash
npm install -g xautojs-devspace
devspace doctor
devspace --help
```

Until the first public npm release exists, prefer source-checkout instructions in
user-facing docs.