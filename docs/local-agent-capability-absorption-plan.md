# Local Agent Capability Absorption Plan

Branch: `plan/local-agent-capability-absorption`

Target repository: `chen362/devspace`

Reference repositories:

- Primary: `chen362/codex`
- Secondary, only where public material is useful: `chen362/claude-code`

## 1. Executive Decision

DevSpace should be evolved into a Codex-style local capability and context-memory layer for ChatGPT web. The priority is not only tools. The highest-value feature to absorb from Codex is its treatment of conversation/work history as a managed context ledger that can be persisted, summarized, compacted, replayed, and safely re-injected.

The intended product boundary is:

```text
ChatGPT Web / Workspace Agent
  = reasoning, conversation, planning, code judgment

DevSpace fork
  = local MCP server, workspace capability layer, context memory, file/git/shell/safety/runtime tools

Local repositories
  = real project files, git worktree, test commands, build commands
```

The intended non-goal is:

```text
ChatGPT Web -> DevSpace -> Codex CLI / Claude Code CLI -> local project
```

That path adds a second agent runtime and can consume Codex/Claude-side usage. The useful parts to absorb are Codex's local context architecture, compaction model, memory/replay discipline, permission model, and review ergonomics, not its model execution loop.

Important constraint:

DevSpace cannot directly compress ChatGPT web's native conversation history. It can maintain a local project/session memory ledger and expose compact, model-ready context back to ChatGPT through MCP tool results, server instructions, app widgets, and explicit context tools. Any LLM summarization should be performed by the ChatGPT web model itself unless the user explicitly opts into a local/API summarizer.

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

DevSpace already has a good MCP product shell. The weak area is the local agent runtime contract behind the tools, especially persistent context memory and context compaction.

Current gap in one sentence:

```text
DevSpace can open a workspace and run tools, but it does not yet remember what matters across turns like Codex does.
```

## 3. Codex Capabilities To Absorb

Observed from `chen362/codex`:

- `codex-rs/core/src/context_manager/history.rs` owns the main `ContextManager`: raw history, prompt-ready history, token usage, history versioning, rollback, function-output truncation, call/output normalization, image stripping, and token estimation.
- `codex-rs/core/src/context_manager/updates.rs` builds incremental model-visible context updates by diffing prior context against the next turn context.
- `codex-rs/core/src/context/*` defines structured context fragments such as environment context, token budget context, rollout budget context, internal model context, user instructions, skills, permissions, and plugin instructions.
- `codex-rs/core/src/compact.rs` implements inline/manual/auto compaction with pre/post compact hooks, compaction metadata, retry handling, and history replacement.
- `codex-rs/core/src/compact_remote.rs` and `compact_remote_v2.rs` implement remote compaction, trim function outputs before compaction, track active context tokens, and install compacted history back into the session.
- `codex-rs/core/src/rollout.rs` bridges rollout recording, archived sessions, thread metadata, thread lookup, summary reads, and the `generate_memories` config flag.
- `codex-rs/core/src/memory_usage.rs` tracks memory-related tool usage based on shell/tool invocation patterns.
- `codex-rs/core/src/apply_patch.rs` routes patch safety through approval policy, permission profile, and filesystem sandbox policy before applying changes.
- `codex-rs/core/src/tools/orchestrator.rs` centralizes approval, sandbox selection, execution attempt, sandbox/network denial handling, and retry/escalation semantics.
- `codex-rs/core/src/tools/sandboxing.rs` defines reusable approval primitives such as `ApprovalStore`, `ExecApprovalRequirement`, `ApprovalCtx`, and `ToolRuntime` abstractions.
- `codex-rs/core/src/exec_policy.rs` evaluates shell commands against policy rules, known-safe heuristics, dangerous-command heuristics, and approval requirements.
- `docs/config.md` points to Codex configuration and lifecycle-hook support.

Absorb these as TypeScript concepts, not by invoking Codex:

```text
context ledger with raw events and model-ready projections
history versioning and checkpointing
reference context diffing
project memory summaries
manual and automatic context compaction
recent tail + compacted summary strategy
token/size budget accounting
context fragments with explicit source markers
function/tool output truncation before replay
call/output pair normalization for model-visible history
rollback-aware context trimming
pre/post compact hooks
rollout/session metadata and archived session lookup
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

Claude Code is not the primary implementation sample here. If its internals are not open or are bundled in a way that makes exact behavior hard to inspect, do not force a clone.

Observed from `chen362/claude-code` public materials:

- Repository README describes Claude Code as a terminal-native agentic coding tool.
- `plugins/README.md` documents plugin components: slash commands, agents, hooks, skills, and MCP servers.
- `.claude-plugin/marketplace.json` models plugin marketplace metadata and plugin discovery.
- `plugins/feature-dev/README.md` documents a structured feature workflow with discovery, codebase exploration, clarification, architecture design, implementation, quality review, and summary.
- `plugins/commit-commands/README.md` documents git workflow automation: commit, push, PR creation, branch cleanup.
- `plugins/security-guidance/README.md` documents hooks for pre-tool pattern warnings, stop-hook diff review, and agentic commit review.
- `plugins/plugin-dev/README.md` documents plugin development practices for hooks, MCP integration, plugin structure, settings, commands, agents, and skills.

Absorb these only as public workflow/plugin patterns:

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
private or non-inspectable Claude Code internals
```

## 5. Target Architecture Sketch

```text
+---------------------------------------------------------------+
| ChatGPT Web / Workspace Agent                                 |
| - owns reasoning and conversation                             |
| - calls MCP tools exposed by DevSpace                         |
| - summarizes context when DevSpace asks it to compact          |
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
|  - app widgets for diffs, approvals, and context memory        |
|                                                               |
|  Workspace Layer                                              |
|  - allowed roots                                              |
|  - checkout/worktree sessions                                 |
|  - AGENTS.md / CLAUDE.md hierarchy                            |
|  - skills/workflow packs                                      |
|                                                               |
|  Context Memory Layer                                         |
|  - raw context events                                         |
|  - model-ready context fragments                              |
|  - project summary, task summary, decisions, assumptions       |
|  - file touch graph and symbol/file relevance memory           |
|  - tool-result summaries                                      |
|  - compaction checkpoints                                     |
|  - token/size budget accounting                               |
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

## 6. Context Memory Design

This is the most important part of the fork.

Codex owns the whole agent conversation, so it can rewrite its internal model history directly. DevSpace cannot rewrite ChatGPT web history. Therefore DevSpace should implement a local context ledger and expose compressed project context through explicit MCP tools.

### 6.1 Context goals

DevSpace should remember:

```text
which workspace is open
which task is active
what the user asked for
what files were inspected
why particular files matter
what commands were run
what outputs mattered
what code was changed
what tests passed/failed
what decisions and assumptions were made
what AGENTS.md / CLAUDE.md instructions apply
what risks or TODOs remain
what summary replaced older detailed context
```

DevSpace should not remember:

```text
secrets
full .env files
full command outputs by default
raw huge logs after they are summarized
private credentials
irrelevant file contents that were only transiently inspected
```

### 6.2 Context ledger model

Add a persistent context ledger on top of `workspace_sessions`.

Suggested tables:

```text
workspace_sessions
  existing table, extended with current_context_window_id and active_task_id

context_windows
  id
  workspace_session_id
  status: active | compacted | archived
  started_at
  closed_at
  token_budget_estimate
  token_estimate
  summary_id

context_events
  id
  workspace_session_id
  context_window_id
  task_id
  type
  source
  path
  content
  metadata_json
  token_estimate
  importance
  created_at

context_summaries
  id
  workspace_session_id
  context_window_id
  parent_summary_id
  summary_kind: project | task | window | file | command | diff | decision
  content
  source_event_ids_json
  token_estimate
  created_at

context_pins
  id
  workspace_session_id
  scope: project | task | file
  key
  content
  reason
  created_at
  updated_at

context_file_facts
  id
  workspace_session_id
  path
  symbols_json
  relevance_notes
  last_read_hash
  last_changed_hash
  last_seen_at
```

Initial event types:

```text
workspace_opened
user_task
agents_instructions_loaded
file_read
search_performed
file_relevance_note
command_run
command_result_summary
patch_applied
diff_summary
test_result
approval_decision
assumption
decision
risk
next_step
manual_note
context_compaction_requested
context_compaction_saved
```

### 6.3 Raw vs projected context

Borrow Codex's distinction between raw history and prompt-ready history.

DevSpace equivalent:

```text
raw ledger
  all stored events after privacy/policy filtering

projected context
  compact, model-visible context returned to ChatGPT
```

Projected context should be built from:

```text
active workspace facts
active task summary
root/nested instructions
recent important events
recent changed files
recent failed checks
pinned decisions
latest compaction summary
remaining TODOs
```

### 6.4 Context fragment format

Borrow Codex-style explicit markers and source labels so the model can distinguish runtime context from user text.

Example projected context:

```text
<devspace_context source="workspace_summary">
Workspace: /Users/abba/code/my-api
Task: improve API error handling
Current branch/worktree: devspace-abc123
Relevant files:
- src/server.ts: Express MCP server and tool registration
- src/pi-tools.ts: local tool wrappers
Recent decisions:
- Keep ChatGPT web as the only model executor.
- Add apply_patch before raw write rewrites.
Open risks:
- run_shell still needs approval policy.
</devspace_context>
```

Rules:

- Every generated context block has a source.
- Context blocks are short by default.
- Long context is exposed through explicit tools, not shoved into every `open_workspace` output.
- Sensitive event types are never projected.

### 6.5 Context budget

Codex tracks token usage and context budget. DevSpace should start with approximate budgeting.

Initial strategy:

```text
approx 4 chars = 1 token
track event token_estimate
track summary token_estimate
projected_context_budget default: 6k tokens
recent_tail_budget default: 3k tokens
summary_budget default: 2k tokens
instructions_budget default: 1k tokens
```

`open_workspace` should return a short budget state:

```json
{
  "context": {
    "windowId": "ctxw_...",
    "estimatedTokens": 1840,
    "budgetTokens": 6000,
    "compactionRecommended": false
  }
}
```

### 6.6 Context compaction model

DevSpace should support two compaction modes.

#### Mode A: deterministic local compaction

No model call. Safe and free.

It summarizes by structure:

```text
keep all pinned decisions
keep latest task summary
keep last N file reads as file facts, not full content
keep last N command summaries, not full output
keep latest diff summary
drop raw large outputs after summary exists
archive old context window
```

Use for automatic compaction when no model summary is available.

#### Mode B: ChatGPT-assisted compaction

Uses the web model already driving the conversation.

Flow:

```text
DevSpace notices context budget pressure
  -> model calls prepare_context_compaction
  -> DevSpace returns compactable events and requested summary schema
  -> ChatGPT writes a concise summary
  -> model calls save_context_summary
  -> DevSpace archives old events behind that summary
```

This keeps summarization inside ChatGPT web and avoids local Codex/Claude usage.

### 6.7 Compaction invariants

Borrow these from Codex's compaction discipline:

```text
preserve latest user task
preserve AGENTS.md/CLAUDE.md instruction sources
preserve approvals and safety decisions
preserve file change summaries
preserve failing test details
preserve unresolved TODOs and risks
preserve recent tail after the last summary
replace large raw outputs with summaries
record a compaction event and checkpoint
increment context history version
```

Do not compact away:

```text
active task objective
explicit user constraints
security constraints
approval decisions
file paths needed to continue
current diff checkpoint
```

### 6.8 Context rollback

Borrow Codex's user-turn rollback idea, but adapt it to workspace events.

Add operations:

```text
rollback_context_to_checkpoint
archive_context_window
restore_context_summary
list_context_checkpoints
```

Rollback should affect local memory/projection only. It should not silently revert files; file rollback remains a separate git/review tool.

### 6.9 Why this comes before patch/shell work

Patch/shell safety matters, but context memory determines whether the web agent can behave like a local coding agent across multiple turns. Without this layer, every new web turn must rediscover files, decisions, and prior test outputs. That makes DevSpace feel like a remote file tool, not a Codex-like local workspace.

## 7. Context MCP Tool Contract V1

These tools should be added before or alongside the policy/patch tools.

### 7.1 `get_workspace_context`

Purpose: return compact model-ready project/session context.

Input:

```json
{
  "workspaceId": "ws_...",
  "scope": "project | task | recent",
  "budgetTokens": 4000
}
```

Output:

```json
{
  "workspaceId": "ws_...",
  "contextWindowId": "ctxw_...",
  "historyVersion": 7,
  "estimatedTokens": 2100,
  "compactionRecommended": false,
  "context": "<devspace_context source=\"workspace_summary\">..."
}
```

Rules:

- Never include denied/sensitive raw content.
- Keep output under requested budget.
- Include enough state for the next model turn to continue without rediscovery.

### 7.2 `record_context_note`

Purpose: let ChatGPT save decisions, assumptions, risks, or next steps into local memory.

Input:

```json
{
  "workspaceId": "ws_...",
  "type": "decision | assumption | risk | next_step | file_relevance_note",
  "content": "Keep ChatGPT web as the only model executor.",
  "path": "docs/local-agent-capability-absorption-plan.md",
  "importance": "low | normal | high | pinned"
}
```

Rules:

- `pinned` notes survive compaction.
- Notes touching sensitive data are rejected.
- Notes are scoped to workspace and optional task.

### 7.3 `list_context_events`

Purpose: inspect local memory events for debugging/resume.

Input:

```json
{
  "workspaceId": "ws_...",
  "type": "decision",
  "limit": 50,
  "cursor": null
}
```

Rules:

- Paginated.
- Defaults to summaries, not raw large payloads.

### 7.4 `prepare_context_compaction`

Purpose: provide compactable history and a strict summary schema to ChatGPT.

Input:

```json
{
  "workspaceId": "ws_...",
  "reason": "manual | budget_pressure | workspace_resume",
  "budgetTokens": 8000
}
```

Output:

```json
{
  "contextWindowId": "ctxw_...",
  "summarySchema": {
    "task": "string",
    "stableFacts": ["string"],
    "decisions": ["string"],
    "files": [{ "path": "string", "whyItMatters": "string" }],
    "changes": ["string"],
    "checks": ["string"],
    "openRisks": ["string"],
    "nextSteps": ["string"]
  },
  "events": []
}
```

Rules:

- Exclude sensitive payloads.
- Include event IDs so the saved summary can reference what it replaced.
- Return concise event summaries, not unbounded logs.

### 7.5 `save_context_summary`

Purpose: persist a ChatGPT-authored compact summary.

Input:

```json
{
  "workspaceId": "ws_...",
  "contextWindowId": "ctxw_...",
  "summaryKind": "window | task | project",
  "summary": {
    "task": "Improve DevSpace into a Codex-style local context layer.",
    "stableFacts": [],
    "decisions": [],
    "files": [],
    "changes": [],
    "checks": [],
    "openRisks": [],
    "nextSteps": []
  },
  "sourceEventIds": ["ce_..."]
}
```

Rules:

- Saves summary.
- Archives or marks replaced events.
- Opens a new context window.
- Increments historyVersion.

### 7.6 `pin_context` / `unpin_context`

Purpose: keep critical memory from being compacted away.

Input:

```json
{
  "workspaceId": "ws_...",
  "key": "executor_boundary",
  "content": "Do not invoke Codex CLI or Claude Code CLI as local model executors.",
  "reason": "cost and product boundary"
}
```

Rules:

- Pins are short.
- Pins are shown in `get_workspace_context` unless explicitly hidden.
- Pins can be updated or removed by key.

## 8. Capability Gap Matrix

| Capability | DevSpace Today | Target Borrowed From | Required Work |
| --- | --- | --- | --- |
| MCP transport/OAuth | Strong | DevSpace | Keep and harden |
| Workspace IDs | Present | DevSpace/Codex sessions | Extend with task/session/context state |
| Context ledger | Missing | Codex `ContextManager` | Add persistent context events, summaries, windows |
| Context projection | Missing | Codex prompt-ready history | Add `get_workspace_context` model-ready summaries |
| Context compaction | Missing | Codex `compact*` | Add deterministic and ChatGPT-assisted compaction |
| Token/size budget | Missing | Codex token budget context | Add approximate budgets and compaction triggers |
| Reference context diffs | Missing | Codex `updates.rs` | Track previous projected context and emit deltas |
| Rollout/session archive | Basic SQLite session only | Codex rollout | Add task/session metadata, archive, resume summaries |
| Allowed roots | Present | DevSpace | Add sensitive-path denylist |
| Read/search/list | Present | DevSpace | Keep, add output caps and context-event summaries |
| Write/edit | Present via write/edit | Codex apply_patch | Add `apply_patch`, deprecate broad overwrite for normal flow |
| Shell | Present as `run_shell`/`bash` | Codex exec policy | Split into `run_check` and approval-gated `run_shell` |
| Approval | OAuth connection only | Codex approval store, Claude hooks | Add per-tool approval queue and cache |
| Sandbox | Path containment only | Codex sandbox vocabulary | Start with policy sandbox, later OS sandbox optional |
| Diff review | `show_changes` | Codex diff loop, Claude Stop hook | Add file-level diff, rollback, accept/review checkpoints |
| Worktree | Present | DevSpace/Codex | Keep; add cleanup/list/rollback tools |
| AGENTS/CLAUDE.md | Present | Codex/Claude | Make hierarchical and budgeted |
| Hooks | Not a first-class runtime | Codex compact hooks, Claude Code hooks | Add lifecycle hook runner including pre/post compact |
| Plugins/skills | Skills present | Claude Code plugin model | Add workflow packs and manifest model |
| Git workflow | Shell-based only | Claude commit commands | Add safe git tool wrappers |
| Security review | Not built in | Claude security-guidance | Add deterministic pattern hooks first |
| Model execution | None | ChatGPT Web | Keep none locally |

## 9. MCP Tool Contract V1

The V1 contract should keep ChatGPT as the only reasoning agent and expose deterministic local tools.

### 9.1 `open_workspace`

Purpose: create or resume a workspace session and context window.

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
  "context": {
    "contextWindowId": "ctxw_...",
    "historyVersion": 1,
    "estimatedTokens": 0,
    "budgetTokens": 6000,
    "compactionRecommended": false
  },
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
- Opening a workspace records a `workspace_opened` context event.
- Reopening an existing workspace should return the latest context summary and active context window.

### 9.2 `read_file`

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
- Each successful read records a small `file_read` event, including path, range, hash, and optional relevance note, not necessarily full content.

### 9.3 `search_files`

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
- Search results should be summarized into context events when useful.

### 9.4 `apply_patch`

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
- A successful patch records `patch_applied` and `diff_summary` context events.

### 9.5 `run_check`

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
- Full raw output is stored only when below size caps; otherwise store a summary and pointer.

### 9.6 `run_shell`

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
- Shell output should always be converted into a bounded context event summary.

### 9.7 `show_changes`

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
- The review summary is recorded in the context ledger.

### 9.8 `rollback_changes`

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
- File rollback and context rollback are separate operations.

### 9.9 `list_approvals` / `resolve_approval`

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
- Approval decisions are pinned or high-importance context events.

## 10. Error Model

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
CONTEXT_WINDOW_NOT_FOUND
CONTEXT_BUDGET_EXCEEDED
CONTEXT_SUMMARY_REQUIRED
CONTEXT_SUMMARY_INVALID
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

## 11. Safety Model

### 11.1 Path policy

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

### 11.2 Context privacy policy

Context memory must never become a secret warehouse.

Rules:

```text
never store denied file contents
never store full .env contents
never store private keys or cloud credentials
store command outputs with caps
summarize large outputs before persistence
redact obvious tokens before storing context events
allow user to clear workspace memory
allow user to export/inspect memory ledger
```

### 11.3 Command policy

Classify commands before running:

```text
allow: read-only git, rg, ls, find, npm test/build/lint from configured checks
ask: package install, migration generation, git commit, git checkout, network access
deny: destructive filesystem commands, privilege escalation, credential reads, pipe-to-shell installers
```

### 11.4 Approval cache

Cache only normalized action keys:

```text
tool + workspaceId + path set + command prefix + policy version
```

Do not cache raw free-form `run_shell` approval as broad shell access.

### 11.5 Hook lifecycle

Borrow Codex and Claude Code hook vocabulary:

```text
SessionStart
PreToolUse
PostToolUse
PreCompact
PostCompact
Stop
SessionEnd
```

Initial hook types:

```text
policy hook: deterministic deny/ask/allow
security hook: pattern warnings on patch/write
context hook: record/summarize relevant events after tool use
compaction hook: prepare/save/validate summaries
review hook: after changes, prompt model to call show_changes
```

V1 hooks should be deterministic local scripts or config rules. LLM-backed hooks are out of scope because they introduce extra model cost unless the model is ChatGPT web performing an explicit compaction workflow.

## 12. Implementation Roadmap

### Phase 0: Planning branch

Deliverable:

- This document.

Exit criteria:

- Branch exists.
- Plan file is readable in `chen362/devspace`.

### Phase 1: Context ledger core

Files likely to add/change:

```text
src/context/context-store.ts
src/context/context-types.ts
src/context/context-projection.ts
src/context/context-budget.ts
src/context/redaction.ts
src/db/schema.ts
src/workspace-store.ts
src/server.ts
```

Work:

- Extend SQLite schema for context windows, events, summaries, pins, and file facts.
- Create a `ContextStore` API.
- Record `workspace_opened`, `file_read`, `search_performed`, `command_result_summary`, `patch_applied`, and `diff_summary` events.
- Add redaction and size caps before persistence.
- Add `get_workspace_context`, `record_context_note`, and `list_context_events` tools.

Exit criteria:

- Opening a workspace creates or resumes a context window.
- Tool calls write bounded context events.
- `get_workspace_context` returns a compact model-ready context block.
- Tests cover persistence, redaction, event ordering, and budget caps.

### Phase 2: Context compaction

Files likely to add/change:

```text
src/context/compaction.ts
src/context/summary-schema.ts
src/context/context-projection.ts
src/server.ts
src/ui/*
```

Work:

- Add deterministic local compaction.
- Add ChatGPT-assisted compaction tools: `prepare_context_compaction`, `save_context_summary`.
- Add `pin_context` and `unpin_context`.
- Add `PreCompact` and `PostCompact` hook points.
- Track `historyVersion` and `contextWindowId`.
- Mark old events as replaced/archived after summary save.

Exit criteria:

- Context can be compacted without model calls.
- ChatGPT can save a structured summary through MCP.
- Pinned memories survive compaction.
- `get_workspace_context` uses latest summary plus recent tail.
- Tests cover summary validation and compaction invariants.

### Phase 3: Policy core

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

### Phase 4: `apply_patch` tool

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
- Record context events after successful patch.

Exit criteria:

- Patch add/update/delete tests.
- Base mismatch test.
- Sensitive path rejection test.
- Diff returned after patch.
- Context ledger records the change summary.

### Phase 5: Command runtime split

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
- Summarize command output into context memory.

Exit criteria:

- `run_check` works for configured commands.
- Unconfigured checks fail with `CHECK_NOT_CONFIGURED`.
- Dangerous shell commands are denied.
- Risky commands create approval records instead of running.
- Command outputs are summarized safely.

### Phase 6: Approval queue and local UI

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
- Record approval decisions as context events.

Exit criteria:

- Risky command can be approved once.
- Same normalized action can be approved for session.
- Denied action returns stable error.

### Phase 7: Diff review and rollback

Files likely to add/change:

```text
src/review-checkpoints.ts
src/git.ts
src/server.ts
src/context/*
src/ui/*
```

Work:

- Add `list_changed_files`.
- Add `show_file_diff`.
- Add `rollback_changes`.
- Add context-only rollback/checkpoint tools.
- Add `accept_changes` or `mark_reviewed` if useful.

Exit criteria:

- File rollback works.
- Session rollback works in managed worktree mode.
- Review checkpoints remain stable after rollback.
- Context rollback does not silently revert files.

### Phase 8: Hierarchical instructions and workflow packs

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
- Store instruction applicability in context memory.

Exit criteria:

- Nested instruction files are surfaced before working in that subtree.
- Workflow pack metadata is discoverable by ChatGPT via `open_workspace`.

### Phase 9: Git workflow wrappers

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
- Git summaries are recorded into context memory.

## 13. Recommended First PR Slice

First implementation PR should be context-first:

```text
PR 1: context ledger core + model-ready workspace context + tests
```

Why:

- It is the feature that makes DevSpace feel Codex-like across multiple turns.
- It is mostly additive and low-risk.
- It does not require changing shell or write behavior first.
- It creates the data model needed for compaction, review, rollback, and future UI.

Second PR:

```text
PR 2: context compaction tools + pins + summary validation
```

Third PR:

```text
PR 3: policy core + sensitive path denylist + tests
```

Fourth PR:

```text
PR 4: apply_patch tool + tests + server instruction update
```

Fifth PR:

```text
PR 5: run_check + command policy gate for run_shell
```

This order prioritizes the user's main requirement: local memory and context compaction before broader tool hardening.

## 14. Explicit Non-Goals

Do not implement in this branch family until the local context/tool layer is stable:

```text
Running Codex CLI as a subprocess
Running Claude Code CLI as a subprocess
Calling Codex SDK/app-server for agent execution
Calling Anthropic Agent SDK for agent execution
LLM-backed local security review hooks
Local model summarization by default
Cloud task synchronization
Multi-agent local orchestration
Unrestricted shell access
Full OS sandbox parity with Codex
```

## 15. Acceptance Criteria For The Overall Project

The fork is successful when a user can say in ChatGPT web:

```text
Open ~/code/my-api, remember the goal, read AGENTS.md,
inspect the error handling path, make the smallest patch,
run tests, show me the diff, and keep enough context so we can continue later.
```

And DevSpace can safely perform:

```text
open_workspace
get_workspace_context
record_context_note
prepare_context_compaction
save_context_summary
read_file / search_files / list_directory
apply_patch
run_check
git_diff / show_changes
rollback if requested
```

Without invoking Codex CLI, Claude Code CLI, Codex SDK, or Claude SDK as local model executors.

A concrete resume scenario should work:

```text
User: continue yesterday's DevSpace MCP refactor.
ChatGPT calls get_workspace_context.
DevSpace returns the latest project/task summary, decisions, touched files, open risks, and next steps.
ChatGPT continues without re-reading the whole repo.
```

## 16. Source Notes

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
codex-rs/core/src/context_manager/history.rs
codex-rs/core/src/context_manager/updates.rs
codex-rs/core/src/context/token_budget_context.rs
codex-rs/core/src/context/rollout_budget.rs
codex-rs/core/src/context/internal_model_context.rs
codex-rs/core/src/context/contextual_user_message.rs
codex-rs/core/src/context/user_instructions.rs
codex-rs/core/src/context/environment_context.rs
codex-rs/core/src/compact.rs
codex-rs/core/src/compact_remote.rs
codex-rs/core/src/compact_remote_v2.rs
codex-rs/core/src/rollout.rs
codex-rs/core/src/memory_usage.rs
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
