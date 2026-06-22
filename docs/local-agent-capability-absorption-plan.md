# Local Agent Capability Absorption Plan

Branch: `plan/local-agent-capability-absorption`

Target repository: `chen362/devspace`

Reference repositories:

- `chen362/codex`
- `chen362/claude-code`

## 1. Executive Decision

DevSpace should be evolved into a Codex/Claude-Code-style local capability layer for ChatGPT web, not into a wrapper that invokes Codex CLI or Claude Code CLI.

The intended product boundary is:

```text
ChatGPT Web / Workspace Agent
  = reasoning, conversation, planning, code judgment

DevSpace fork
  = local MCP server, workspace capability layer, file/git/shell/safety/runtime tools

Local repositories
  = real project files, git worktree, test commands, build commands
```

The intended non-goal is:

```text
ChatGPT Web -> DevSpace -> Codex CLI / Claude Code CLI -> local project
```

That path would add a second agent runtime and can consume Codex/Claude-side usage. The useful parts to absorb are the local runtime capabilities, permission model, workflow structure, and review ergonomics, not their model execution loops.

## 2. Current DevSpace Baseline

Observed from `chen362/devspace`:

- `package.json` defines a Node/TypeScript MCP server package with Express, MCP SDK, MCP Apps widgets, SQLite, and `@earendil-works/pi-coding-agent`.
- `src/server.ts` owns the Streamable HTTP MCP server, OAuth-protected MCP endpoint, tool registration, widgets, and server instructions.
- `src/pi-tools.ts` wraps `@earendil-works/pi-coding-agent` tools for read, write, edit, grep, find, ls, and bash.
- `src/roots.ts` enforces allowed root path containment.
- `src/workspaces.ts` manages checkout/worktree workspace opening, workspace IDs, AGENTS/CLAUDE.md discovery, skill discovery, and path resolution.
- `src/git-worktrees.ts` creates isolated managed git worktrees.
- `src/review-checkpoints.ts` snapshots git state and implements aggregate diff review via `show_changes`.
- `src/workspace-store.ts` persists workspace sessions in SQLite.

DevSpace already has a good MCP product shell. The weak area is the local agent runtime contract behind the tools.

## 3. Codex Capabilities To Absorb

Observed from `chen362/codex`:

- `codex-rs/core/src/apply_patch.rs` routes patch safety through approval policy, permission profile, and filesystem sandbox policy before applying changes.
- `codex-rs/core/src/tools/orchestrator.rs` centralizes approval, sandbox selection, execution attempt, sandbox/network denial handling, and retry/escalation semantics.
- `codex-rs/core/src/tools/sandboxing.rs` defines reusable approval primitives such as `ApprovalStore`, `ExecApprovalRequirement`, `ApprovalCtx`, and `ToolRuntime` abstractions.
- `codex-rs/core/src/exec_policy.rs` evaluates shell commands against policy rules, known-safe heuristics, dangerous-command heuristics, and approval requirements.
- `docs/config.md` points to Codex configuration and lifecycle-hook support.

Absorb these as TypeScript concepts, not by invoking Codex:

```text
apply_patch-first editing
command policy engine
approval queue and approval cache
sandbox/permission profile vocabulary
safe/risky/forbidden command classification
network access classification
structured tool run result model
diff-first review loop
lifecycle hooks around tool calls
```

Do not absorb these for the first implementation:

```text
Codex model provider
Codex SDK/app-server thread execution
codex exec/run as a subprocess
Codex cloud/remote task behavior
subagents as model workers
```

## 4. Claude Code Capabilities To Absorb

Observed from `chen362/claude-code`:

- Repository README describes Claude Code as a terminal-native agentic coding tool.
- `plugins/README.md` documents plugin components: slash commands, agents, hooks, skills, and MCP servers.
- `.claude-plugin/marketplace.json` models plugin marketplace metadata and plugin discovery.
- `plugins/feature-dev/README.md` documents a structured feature workflow with discovery, codebase exploration, clarification, architecture design, implementation, quality review, and summary.
- `plugins/commit-commands/README.md` documents git workflow automation: commit, push, PR creation, branch cleanup.
- `plugins/security-guidance/README.md` documents hooks for pre-tool pattern warnings, stop-hook diff review, and agentic commit review.
- `plugins/plugin-dev/README.md` documents plugin development practices for hooks, MCP integration, plugin structure, settings, commands, agents, and skills.

Absorb these as local workflow/plugin patterns:

```text
plugin manifest and marketplace model
slash-command-like workflow templates
project/user settings files
hook lifecycle: SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd
security guidance hooks around writes and diffs
feature workflow templates
commit/PR workflow templates
specialized guidance packs, not model subagents in v1
```

Do not absorb these for the first implementation:

```text
Claude Code model runtime
Claude Code CLI subprocess execution
Claude subagents as independent model calls
provider-specific Claude settings or costs
```

## 5. Target Architecture Sketch

```text
+---------------------------------------------------------------+
| ChatGPT Web / Workspace Agent                                 |
| - owns reasoning and conversation                             |
| - calls MCP tools exposed by DevSpace                         |
+-------------------------------+-------------------------------+
                                |
                                | Streamable HTTP MCP / OAuth
                                v
+---------------------------------------------------------------+
| DevSpace Local MCP Server                                     |
|                                                               |
|  Transport/Auth Layer                                         |
|  - Express + MCP SDK + OAuth                                  |
|  - tunnel/public URL                                          |
|  - app widgets for diffs and approvals                        |
|                                                               |
|  Workspace Layer                                              |
|  - allowed roots                                              |
|  - checkout/worktree sessions                                 |
|  - AGENTS.md / CLAUDE.md hierarchy                            |
|  - skills/workflow packs                                      |
|                                                               |
|  Capability Runtime Layer                                     |
|  - tool registry                                              |
|  - policy evaluator                                           |
|  - approval queue/cache                                       |
|  - denylist and sensitive-path guard                          |
|  - command classifier                                         |
|  - patch validator                                            |
|  - hooks lifecycle                                            |
|                                                               |
|  Local Tool Layer                                             |
|  - read/search/list                                           |
|  - apply_patch                                                |
|  - git diff/status/worktree/rollback                          |
|  - run_check whitelist                                        |
|  - optional approved run_shell                                |
+-------------------------------+-------------------------------+
                                |
                                v
+---------------------------------------------------------------+
| Local Project                                                  |
| - source files                                                 |
| - git checkout or isolated worktree                            |
| - package manager/test/build commands                          |
+---------------------------------------------------------------+
```

## 6. Capability Gap Matrix

| Capability | DevSpace Today | Target Borrowed From | Required Work |
| --- | --- | --- | --- |
| MCP transport/OAuth | Strong | DevSpace | Keep and harden |
| Workspace IDs | Present | DevSpace/Codex sessions | Extend with task/session state |
| Allowed roots | Present | DevSpace | Add sensitive-path denylist |
| Read/search/list | Present | DevSpace | Keep, add output caps |
| Write/edit | Present via write/edit | Codex apply_patch | Add `apply_patch`, deprecate broad overwrite for normal flow |
| Shell | Present as `run_shell`/`bash` | Codex exec policy | Split into `run_check` and approval-gated `run_shell` |
| Approval | OAuth connection only | Codex approval store, Claude hooks | Add per-tool approval queue and cache |
| Sandbox | Path containment only | Codex sandbox vocabulary | Start with policy sandbox, later OS sandbox optional |
| Diff review | `show_changes` | Codex diff loop, Claude Stop hook | Add file-level diff, rollback, accept/review checkpoints |
| Worktree | Present | DevSpace/Codex | Keep; add cleanup/list/rollback tools |
| AGENTS/CLAUDE.md | Present | Codex/Claude | Make hierarchical and budgeted |
| Hooks | Not a first-class runtime | Claude Code | Add lifecycle hook runner |
| Plugins/skills | Skills present | Claude Code plugin model | Add workflow packs and manifest model |
| Git workflow | Shell-based only | Claude commit commands | Add safe git tool wrappers |
| Security review | Not built in | Claude security-guidance | Add deterministic pattern hooks first |
| Model execution | None | ChatGPT Web | Keep none locally |

## 7. MCP Tool Contract V1

The V1 contract should keep ChatGPT as the only reasoning agent and expose deterministic local tools.

### 7.1 `open_workspace`

Purpose: create or resume a workspace session.

Input:

```json
{
  "path": "~/code/project",
  "mode": "checkout | worktree",
  "baseRef": "HEAD"
}
```

Stable output:

```json
{
  "workspaceId": "ws_...",
  "root": "/abs/path",
  "mode": "checkout",
  "sourceRoot": null,
  "worktree": null,
  "agentsFiles": [],
  "availableAgentsFiles": [],
  "skills": [],
  "policy": {
    "writeMode": "patch_first",
    "shellMode": "checks_only_by_default"
  }
}
```

Rules:

- `path` must resolve inside `allowedRoots`.
- `mode=worktree` must create a managed worktree under `worktreeRoot`.
- Response must include loaded root instructions and nested instruction candidates.

### 7.2 `read_file`

Purpose: read project or activated skill files.

Input:

```json
{
  "workspaceId": "ws_...",
  "path": "src/server.ts",
  "offset": 1,
  "limit": 200
}
```

Rules:

- Path must be inside workspace root or an activated skill directory.
- Denied files return a typed policy error, not raw filesystem errors.
- Large files must be windowed with `offset` and `limit`.

### 7.3 `search_files`

Purpose: find symbols, text, files, and instructions.

Input:

```json
{
  "workspaceId": "ws_...",
  "query": "apply_patch",
  "path": "src",
  "kind": "text | file"
}
```

Rules:

- Must respect denylist and ignored heavy directories.
- Must cap output and ask model to narrow when too broad.

### 7.4 `apply_patch`

Purpose: apply targeted changes with Codex-style patch discipline.

Input:

```json
{
  "workspaceId": "ws_...",
  "patch": "*** Begin Patch\n...\n*** End Patch",
  "baseVersion": {
    "files": {
      "src/server.ts": "sha256:..."
    }
  }
}
```

Stable output:

```json
{
  "status": "applied",
  "changedFiles": ["src/server.ts"],
  "summary": { "files": 1, "additions": 12, "removals": 4 },
  "diff": "diff --git ..."
}
```

Rules:

- Patch paths must stay inside workspace root.
- Sensitive paths are rejected even if inside root.
- If `baseVersion` mismatches, return `409 PATCH_BASE_MISMATCH` and do not write.
- If the patch touches risky paths or many files, require approval.
- The tool is idempotent only for identical patch + identical baseVersion + unchanged files.

### 7.5 `run_check`

Purpose: run approved project checks without exposing arbitrary shell.

Input:

```json
{
  "workspaceId": "ws_...",
  "name": "test",
  "timeoutSeconds": 120
}
```

Config-backed command examples:

```json
{
  "test": "npm test",
  "lint": "npm run lint",
  "build": "npm run build",
  "pytest": "pytest"
}
```

Rules:

- Only configured names are accepted.
- Command runs in workspace root unless a configured working directory is present.
- Output is capped and summarized.

### 7.6 `run_shell`

Purpose: optional escape hatch for commands not represented by `run_check`.

Input:

```json
{
  "workspaceId": "ws_...",
  "command": "git status --short",
  "workingDirectory": ".",
  "timeoutSeconds": 30,
  "reason": "inspect current changes"
}
```

Rules:

- Default mode should be disabled or approval-gated.
- Command policy returns one of `allow`, `ask`, `deny` before execution.
- Shell write patterns are denied unless explicitly approved:
  - heredocs
  - redirection to files
  - `tee`
  - `sed -i`
  - inline node/python/perl/ruby scripts that write files
- Dangerous commands are denied by default:
  - `rm -rf`
  - `sudo`
  - `curl | sh`
  - credential exfiltration patterns
  - direct reads of `.env`, `.ssh`, cloud credential folders

### 7.7 `show_changes`

Purpose: aggregate review of changes since a checkpoint.

Input:

```json
{
  "workspaceId": "ws_...",
  "since": "last_shown | workspace_open | last_review",
  "markReviewed": true
}
```

Output:

```json
{
  "summary": { "files": 2, "additions": 24, "removals": 8 },
  "files": [],
  "patch": "diff --git ..."
}
```

Rules:

- Must not mutate project files.
- `markReviewed=true` advances the review checkpoint.

### 7.8 `rollback_changes`

Purpose: restore one file or the entire current session to a checkpoint.

Input:

```json
{
  "workspaceId": "ws_...",
  "scope": "file | session",
  "path": "src/server.ts",
  "checkpoint": "workspace_open | last_review"
}
```

Rules:

- Rollback requires approval when it discards user-visible changes.
- Must return diff summary after rollback.

### 7.9 `list_approvals` / `resolve_approval`

Purpose: let the local owner review pending risky actions.

Input:

```json
{
  "workspaceId": "ws_..."
}
```

Resolution input:

```json
{
  "approvalId": "ap_...",
  "decision": "approve_once | approve_for_session | deny",
  "comment": "optional reason"
}
```

Rules:

- Approval records must include tool, normalized action, paths, command preview, risk level, and createdAt.
- `approve_for_session` must cache only equivalent action keys, not broad arbitrary future actions.

## 8. Error Model

Use a stable error shape for tool failures:

```json
{
  "error": {
    "code": "PATH_DENIED",
    "message": "Path is outside the opened workspace.",
    "details": {
      "path": "../secret.txt",
      "workspaceId": "ws_..."
    },
    "retryable": false
  }
}
```

Initial codes:

```text
WORKSPACE_NOT_FOUND
PATH_DENIED
SENSITIVE_PATH_DENIED
PATCH_PARSE_FAILED
PATCH_BASE_MISMATCH
PATCH_POLICY_REQUIRES_APPROVAL
COMMAND_DENIED
COMMAND_REQUIRES_APPROVAL
COMMAND_TIMEOUT
CHECK_NOT_CONFIGURED
GIT_REQUIRED
GIT_DIRTY_SOURCE
ROLLBACK_REQUIRES_APPROVAL
INTERNAL_TOOL_ERROR
```

## 9. Safety Model

### 9.1 Path policy

Keep allowed roots, then add deny rules inside roots.

Default deny examples:

```text
.env
.env.*
**/.env
**/.env.*
**/.ssh/**
**/.aws/**
**/.config/**
**/credentials.json
**/*secret*
**/*token*
**/.git/** for normal file reads/writes
```

Allow `.git` only through explicit git tools, not generic read/write.

### 9.2 Command policy

Classify commands before running:

```text
allow: read-only git, rg, ls, find, npm test/build/lint from configured checks
ask: package install, migration generation, git commit, git checkout, network access
deny: destructive filesystem commands, privilege escalation, credential reads, pipe-to-shell installers
```

### 9.3 Approval cache

Cache only normalized action keys:

```text
tool + workspaceId + path set + command prefix + policy version
```

Do not cache raw free-form `run_shell` approval as broad shell access.

### 9.4 Hook lifecycle

Borrow Claude Code hook vocabulary:

```text
SessionStart
PreToolUse
PostToolUse
Stop
SessionEnd
```

Initial hook types:

```text
policy hook: deterministic deny/ask/allow
security hook: pattern warnings on patch/write
review hook: after changes, prompt model to call show_changes
```

V1 hooks should be deterministic local scripts or config rules. LLM-backed hooks are out of scope because they introduce extra model cost.

## 10. Implementation Roadmap

### Phase 0: Planning branch

Deliverable:

- This document.

Exit criteria:

- Branch exists.
- Plan file is readable in `chen362/devspace`.

### Phase 1: Policy core

Files likely to add:

```text
src/policy/path-policy.ts
src/policy/command-policy.ts
src/policy/approval-store.ts
src/policy/errors.ts
src/policy/types.ts
```

Work:

- Add stable error codes.
- Add path denylist.
- Add command classifier.
- Add approval data model and SQLite migration.
- Add tests for path/command policy.

Exit criteria:

- Existing tests pass.
- New tests cover allow/ask/deny command decisions.
- No MCP tool behavior changes yet except internal policy utilities.

### Phase 2: `apply_patch` tool

Files likely to add/change:

```text
src/patch/apply-patch.ts
src/patch/parse-patch.ts
src/pi-tools.ts
src/server.ts
src/review-checkpoints.ts
```

Work:

- Add patch parser or integrate a proven patch library.
- Enforce workspace root and denylist.
- Add optional base file hash validation.
- Return changed files, stats, and unified diff.
- Update server instructions to prefer `apply_patch`.
- Keep existing `edit` for compatibility, but mark `apply_patch` as preferred.

Exit criteria:

- Patch add/update/delete tests.
- Base mismatch test.
- Sensitive path rejection test.
- Diff returned after patch.

### Phase 3: Command runtime split

Files likely to add/change:

```text
src/checks.ts
src/policy/command-policy.ts
src/server.ts
src/pi-tools.ts
src/config.ts
```

Work:

- Add `run_check` tool using config-defined check names.
- Put `run_shell` behind command policy.
- Deny shell file mutation patterns by default.
- Add optional approval-gated shell execution.
- Add output caps and timeout consistency.

Exit criteria:

- `run_check` works for configured commands.
- Unconfigured checks fail with `CHECK_NOT_CONFIGURED`.
- Dangerous shell commands are denied.
- Risky commands create approval records instead of running.

### Phase 4: Approval queue and local UI

Files likely to add/change:

```text
src/approvals.ts
src/db/schema.ts
src/server.ts
src/ui/*
```

Work:

- Persist pending approvals.
- Expose `list_approvals` and `resolve_approval` tools.
- Add browser/local owner approval page or reuse MCP app widget.
- Add session-scoped approval cache.

Exit criteria:

- Risky command can be approved once.
- Same normalized action can be approved for session.
- Denied action returns stable error.

### Phase 5: Diff review and rollback

Files likely to add/change:

```text
src/review-checkpoints.ts
src/git.ts
src/server.ts
src/ui/*
```

Work:

- Add `list_changed_files`.
- Add `show_file_diff`.
- Add `rollback_changes`.
- Add `accept_changes` or `mark_reviewed` if useful.

Exit criteria:

- File rollback works.
- Session rollback works in managed worktree mode.
- Review checkpoints remain stable after rollback.

### Phase 6: Hierarchical instructions and workflow packs

Files likely to add/change:

```text
src/workspaces.ts
src/skills.ts
src/workflows/*
docs/workflow-packs.md
```

Work:

- Load AGENTS.md/CLAUDE.md by path hierarchy, not just root plus discovered files.
- Add token/size budgets and source labels.
- Add workflow pack manifest inspired by Claude Code plugins.
- Start with built-in packs:
  - feature-dev
  - code-review
  - security-guidance
  - commit-workflow

Exit criteria:

- Nested instruction files are surfaced before working in that subtree.
- Workflow pack metadata is discoverable by ChatGPT via `open_workspace`.

### Phase 7: Git workflow wrappers

Files likely to add/change:

```text
src/git-tools.ts
src/server.ts
src/policy/command-policy.ts
```

Work:

- Add `git_status`.
- Add `git_diff`.
- Add `git_log` with caps.
- Add approval-gated `git_commit`.
- Add optional `git_create_branch`.

Exit criteria:

- Common git workflows no longer need raw shell.
- Commit refuses sensitive files by default.

## 11. Recommended First PR Slice

First implementation PR should be deliberately small:

```text
PR 1: policy core + sensitive path denylist + tests
```

Why:

- It is foundational.
- It does not risk breaking MCP tool behavior.
- It creates vocabulary for later patch/shell/approval work.

Second PR:

```text
PR 2: apply_patch tool + tests + server instruction update
```

Third PR:

```text
PR 3: run_check + command policy gate for run_shell
```

This order avoids a big-bang rewrite.

## 12. Explicit Non-Goals

Do not implement in this branch family until the local tool layer is stable:

```text
Running Codex CLI as a subprocess
Running Claude Code CLI as a subprocess
Calling Codex SDK/app-server for agent execution
Calling Anthropic Agent SDK for agent execution
LLM-backed security review hooks
Cloud task synchronization
Multi-agent local orchestration
Unrestricted shell access
Full OS sandbox parity with Codex
```

## 13. Acceptance Criteria For The Overall Project

The fork is successful when a user can say in ChatGPT web:

```text
Open ~/code/my-api, read AGENTS.md, inspect the error handling path,
make the smallest patch, run tests, and show me the diff.
```

And DevSpace can safely perform:

```text
open_workspace
read_file / search_files / list_directory
apply_patch
run_check
git_diff / show_changes
rollback if requested
```

Without invoking Codex CLI, Claude Code CLI, Codex SDK, or Claude SDK as local model executors.

## 14. Source Notes

DevSpace source files reviewed:

```text
README.md
package.json
src/server.ts
src/pi-tools.ts
src/roots.ts
src/workspaces.ts
src/git-worktrees.ts
src/review-checkpoints.ts
src/workspace-store.ts
src/config.ts
```

Codex source files reviewed:

```text
README.md
codex-rs/core/src/apply_patch.rs
codex-rs/core/src/tools/orchestrator.rs
codex-rs/core/src/tools/sandboxing.rs
codex-rs/core/src/exec_policy.rs
docs/config.md
```

Claude Code source/docs reviewed:

```text
README.md
plugins/README.md
.claude-plugin/marketplace.json
plugins/feature-dev/README.md
plugins/commit-commands/README.md
plugins/security-guidance/README.md
plugins/plugin-dev/README.md
```
