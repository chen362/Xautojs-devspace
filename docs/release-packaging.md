# Release Packaging

This document is the release contract for publishing Xautojs DevSpace as an
independent package. It keeps package identity, CLI naming, lockfile metadata,
and npm release steps consistent as the project moves away from the upstream
DevSpace package name.

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

## Release Scripts

The repository includes release guardrails so packaging checks can run without
network access:

```bash
npm run release:sync-lockfile
npm run release:check
```

`release:sync-lockfile` copies root package metadata from `package.json` into
`package-lock.json`:

```text
name
version
packages[""].name
packages[""].version
packages[""].license
packages[""].bin
packages[""].engines
```

Run it after changing `package.json` name, version, bin, license, or engines. If
it changes `package-lock.json`, commit that diff before publishing.

`release:check` fails when release-facing metadata is inconsistent. It checks the
package name, CLI binary, publish access, repository links, `files` allowlist,
lockfile root metadata, and stale `@waishnav/devspace` identity in package root
metadata.

`prepublishOnly` runs:

```bash
npm run release:check
npm run typecheck
npm test
npm run build
```

This means `npm publish` should fail before upload if package identity, lockfile
metadata, tests, or build output are not ready.

## Versioning

Use semver:

- Patch: documentation, bug fixes, compatibility-preserving operator/runtime
  fixes.
- Minor: new runtime features, new operator endpoints, new workflow packs, or new
  config keys with compatible defaults.
- Major: breaking API contracts, CLI command removals, storage migration rules
  that require manual operator action, or dropping the `devspace` compatibility
  binary.

Version bumps should update both `package.json` and `package-lock.json`. The
lowest-friction flow is:

```bash
npm version patch --no-git-tag-version
npm run release:sync-lockfile
git diff -- package.json package-lock.json
```

Use `minor`, `major`, or an explicit version instead of `patch` when appropriate.

## npm Tag Strategy

Use npm dist-tags intentionally:

- `latest` for stable releases users should install by default.
- `next` for release candidates, prereleases, or compatibility testing before a
  stable tag.

Stable publish:

```bash
npm publish --access public --tag latest
```

Prerelease publish:

```bash
npm version prerelease --preid rc --no-git-tag-version
npm run release:sync-lockfile
npm publish --access public --tag next
```

Do not publish `@waishnav/devspace` from this repository. If upstream compatibility
notes are needed, document them as migration guidance, not as npm identity.

## Pre-Publish Checklist

Run from a clean checkout of `Xautojs-devspace`:

```bash
npm ci
npm run release:sync-lockfile
git diff --exit-code -- package.json package-lock.json
npm run release:check
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

If `npm run release:sync-lockfile` changes `package-lock.json`, commit the lockfile
metadata update, then restart the checklist from `npm ci`.

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
npm publish --access public --tag latest
```

After publishing, smoke test the package in a fresh directory:

```bash
npm install -g xautojs-devspace
devspace doctor
devspace --help
```

Until the first public npm release exists, prefer source-checkout instructions in
user-facing docs.

## CLI Compatibility

The package identity is `xautojs-devspace`, but the executable remains
`devspace`:

```bash
npm install -g xautojs-devspace
devspace doctor
```

Keep `devspace` as the installed binary for all 1.x releases unless a future
major-version migration guide explicitly removes it. Existing scripts, local
config, docs, and operator runbooks should continue to use `devspace` for the
installed package and `node dist/cli.js ...` for source checkouts.
