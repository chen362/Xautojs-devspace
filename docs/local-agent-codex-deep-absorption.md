# Codex Deep Capability Absorption Addendum

Branch: `plan/local-agent-capability-absorption`

Companion to: `docs/local-agent-capability-absorption-plan.md`

## 1. Product Target

The target is stronger than "DevSpace can edit local files".

The target is:

```text
ChatGPT Web
  -> MCP
  -> DevSpace multidimensional local API gateway
  -> workspace files, git state, command runtime, visual/document assets, context memory
```

ChatGPT Web remains the reasoning and conversation layer. DevSpace becomes the local capability, memory, safety, and UI gateway.

The goal is to absorb Codex's highest-value local-agent abilities without consuming Codex as a second model executor, then exceed Codex where a web-connected MCP gateway can be stronger.

## 2. What Is Not Fully Absorbed Yet

The previous plan already covers the main architecture and context-memory priority. It is not "complete" in the sense of implementation scope. It still needs these deep Codex-inspired layers before the fork can feel like a serious local agent runtime:

```text
1. context fabric
2. tool runtime bus
3. policy and approval engine
4. patch-first editing engine
5. diff and rollback engine
6. command execution profiles
7. event stream and UI protocol
8. multimodal local asset gateway
9. evaluation and replay harness
10. plugin/workflow pack system
```

The most important update is this:

```text
Context memory is the foundation, but the product should not stop at memory.
Memory must feed a deterministic local capability bus that can safely inspect, edit, test, review, and resume work.
```

## 3. Codex Capability Map

Codex areas reviewed and what DevSpace should absorb:

| Codex area | What Codex does | DevSpace translation |
| --- | --- | --- |
| `context_manager/history.rs` | Maintains raw history, prompt-ready history, token usage, rollback, tool-output truncation | Local context ledger plus model-ready projection exposed through MCP |
| `compact.rs`, `compact_remote*.rs` | Manual, auto, inline, and remote compaction with hooks and history replacement | ChatGPT-assisted compaction tools plus deterministic local summary validation |
| `rollout.rs` | Records sessions, thread metadata, archived sessions, summaries, memory generation | Workspace session archive, resumable task timeline, searchable summaries |
| `tools/orchestrator.rs` | Centralizes approval, sandbox selection, attempts, retry/escalation, network approval | DevSpace `ToolRuntimeBus` around every local capability |
| `tools/sandboxing.rs` | Approval cache, approval context, sandbox attempt types, runtime traits | TypeScript approval store, permission profile, runtime attempt model |
| `exec_policy.rs` | Rule-based command policy, safe/dangerous heuristics, amendment suggestions | DevSpace command policy engine and local rule files |
| `apply_patch.rs` and `apply-patch` crate | Parses, verifies, applies, and records patch deltas | First-class `apply_patch` MCP tool, not shell redirection |
| `safety.rs` | Rejects or prompts writes outside trusted paths/read-only sandbox | Writable-root validator and sensitive path guard |
| `turn_diff_tracker.rs` | Tracks current-turn patch deltas without rereading the full filesystem | Per-task diff tracker, review stream, rollback metadata |
| `exec.rs` | Bounded process execution, timeout/cancel, output caps, streaming deltas | `run_check`/`run_shell` runtime with byte caps, cancellation, streaming events |
| TUI `chatwidget.rs` | Renders transcript, active tool groups, approvals, token/rate state, overlays | Local desktop/web UI event timeline and inspector panels |
| app-server `lib.rs` | Transport, session coordination, config, thread state, skills, plugins | DevSpace local control plane and UI/API gateway |

## 4. Absorption Principles

### 4.1 Absorb behavior, not provider dependency

Do not pipe ChatGPT Web into Codex CLI or Claude Code CLI. Absorb the behavior patterns:

```text
good: DevSpace implements Codex-like context compaction
bad: DevSpace calls `codex exec` to compact context

good: DevSpace implements Codex-like apply_patch validation
bad: DevSpace shells out to Codex for editing

good: DevSpace implements Codex-like command policy
bad: DevSpace delegates safety to a second agent process
```

### 4.2 Make every local action event-sourced

Every meaningful action should become a structured event:

```text
workspace.opened
context.projected
context.compaction.requested
context.compaction.saved
file.read
search.completed
asset.inspected
patch.previewed
patch.applied
command.policy.evaluated
command.started
command.output.delta
command.finished
approval.requested
approval.resolved
diff.generated
rollback.created
rollback.applied
```

This lets DevSpace resume, render UI, compact, audit, and replay work.

### 4.3 Prefer model-ready projections over dumping raw state

Codex has raw history and prompt-ready history. DevSpace should mirror that split:

```text
raw event ledger: exact local truth
model projection: compact, source-labeled, token-budgeted context
UI projection: human-readable timeline, panels, badges, diffs
```

### 4.4 Context should be multi-facet, not only chronological

Codex's memory is largely conversation/session oriented. DevSpace can exceed it by keeping facet-specific local memory:

```text
goal memory
open question memory
assumption memory
decision memory
file fact memory
symbol fact memory
API contract memory
test result memory
diff memory
risk memory
asset/OCR/document memory
approval memory
```

## 5. Target Runtime Bus

Add a `ToolRuntimeBus` that wraps all tools. No tool should directly perform a risky local action without going through the bus.

### 5.1 Runtime lifecycle

```text
1. receive MCP tool call
2. normalize input
3. bind workspace and caller identity
4. attach context window
5. classify capability and risk
6. evaluate policy
7. request approval if needed
8. select runtime profile
9. execute with timeout/output limits
10. summarize result
11. record context event
12. emit UI event
13. return model-ready result
```

### 5.2 Runtime attempt model

```ts
interface RuntimeAttempt {
  attemptId: string;
  toolCallId: string;
  workspaceId: string;
  capability: CapabilityName;
  risk: "read" | "write" | "execute" | "network" | "destructive";
  permissionProfile: PermissionProfile;
  approvalStatus: "not_required" | "pending" | "approved" | "denied";
  sandboxProfile: "read_only" | "workspace_write" | "network_blocked" | "network_allowed" | "unsandboxed";
  startedAt: string;
  finishedAt?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
}
```

### 5.3 Result model

Every tool result should have the same envelope shape internally, even if MCP returns a simpler public schema.

```ts
interface RuntimeResult<T = unknown> {
  resultText: string;
  data?: T;
  events: ContextEvent[];
  uiEvents: UiEvent[];
  summary: ToolResultSummary;
  warnings: RuntimeWarning[];
  retry?: RetryAdvice;
}
```

## 6. Command Execution Profiles

Absorb Codex's command policy and execution discipline, but implement a web/MCP-friendly shape.

### 6.1 Command classes

```text
read_only:
  pwd, ls, find, rg, git status, git diff, git log, cat through read_file preferred

check:
  npm test, pnpm test, pytest, go test, cargo test, tsc --noEmit, lint commands

build:
  npm run build, cargo build, go build, docker build when explicitly allowed

network:
  npm install, pnpm install, pip install, curl, wget, git fetch, git pull

write:
  formatters, code generators, migrations, package lock updates

destructive:
  rm -rf, git reset --hard, git clean, chmod/chown broad paths, database deletes

forbidden_by_default:
  credential reads, SSH key reads, cloud secret commands, arbitrary shell scripts that hide writes
```

### 6.2 Tools split

Do not expose one giant raw shell as the primary interface.

Recommended split:

```text
run_check       approval-light, test/build/lint oriented
run_command     policy-gated, explicit command and purpose
run_shell       advanced escape hatch, off or strict by default
install_deps    explicit network/dependency tool
start_server    long-running process manager
stop_server     process manager cleanup
```

### 6.3 Output discipline

Codex caps shell output and streams deltas. DevSpace should do the same:

```text
stdout/stderr byte cap
live output events for UI
tail summary for model
full logs saved locally only when useful
error classification
retry advice
```

## 7. Patch-First Editing

DevSpace should move from generic write/edit wrappers toward Codex-style patch-first editing.

### 7.1 Why

Patch-first editing gives the user and the model:

```text
smaller trusted mutation surface
reviewable change intent
path-level approval
better rollback
better diff UI
clean context events
```

### 7.2 Apply patch lifecycle

```text
prepare_patch
  parse patch
  validate paths
  classify changes
  calculate preview diff
  estimate risk

approve_patch
  auto-approve safe workspace writes when policy allows
  otherwise request path-level approval

apply_patch
  apply through filesystem abstraction
  track exact delta
  update review checkpoint
  emit patch.applied event

review_patch
  show unified diff, file summary, test recommendations

rollback_patch
  revert by exact delta or git snapshot
```

### 7.3 Exceed Codex

Codex is excellent at patch execution, but DevSpace can exceed it with richer UI and gateway metadata:

```text
path-by-path approval chips
file ownership hints from AGENTS.md hierarchy
semantic diff grouping by feature/test/docs/config
context events attached to each patch hunk
visual rollback timeline
model-readable diff summary plus human diff viewer
```

## 8. Context Fabric Beyond Codex

The context layer should become a product advantage, not just a safety copy of Codex.

### 8.1 Context memory facets

```ts
interface ContextMemoryFacets {
  project: ProjectSummary;
  task: TaskSummary;
  decisions: DecisionMemory[];
  assumptions: AssumptionMemory[];
  openQuestions: OpenQuestionMemory[];
  fileFacts: FileFactMemory[];
  symbolFacts: SymbolFactMemory[];
  apiContracts: ApiContractMemory[];
  commands: CommandMemory[];
  diffs: DiffMemory[];
  risks: RiskMemory[];
  assets: AssetMemory[];
  pins: ContextPin[];
}
```

### 8.2 Context projection modes

```text
brief:
  goal, latest summary, next steps, top touched files

coding:
  goal, constraints, relevant file facts, decisions, current diff, last tests

review:
  changed files, risks, test results, unresolved approvals, rollback points

resume:
  project summary, active task, decisions, open questions, next steps

asset:
  image/PDF/document summaries, extracted text, relevant files, user notes
```

MCP tool:

```text
get_workspace_context({ workspaceId, mode, tokenBudget, includePins, includeRecentEvents })
```

### 8.3 Compaction quality gates

A saved summary must include:

```text
goal
current state
important decisions
files read
files changed
test/build results
open risks
next steps
what not to forget
```

Reject or warn on summaries that omit files changed, decisions, or next steps.

## 9. Multidimensional Multimodal API Gateway

The user's target explicitly includes a multi-dimensional, multimodal API gateway. This should be a first-class layer, not an afterthought.

### 9.1 Gateway dimensions

```text
filesystem dimension:
  read, write, patch, list, search, metadata, watch

git dimension:
  status, diff, log, branch, worktree, checkpoint, rollback

process dimension:
  check, build, test, server, logs, cancellation

context dimension:
  events, summaries, pins, compaction, projections, resume

policy dimension:
  permissions, approvals, rules, sensitive paths, audit

asset dimension:
  images, PDFs, Office files, CSV/XLSX, archives, binary metadata

UI dimension:
  timeline events, approval modals, diff panels, context panels, notifications

integration dimension:
  MCP, local REST/WebSocket, optional desktop shell, optional browser extension
```

### 9.2 Multimodal tools

Add tools only when they are deterministic local capability, not hidden local model calls.

```text
inspect_asset
  file metadata, mime type, dimensions, pages, sheets, encodings

extract_text
  PDF, DOCX, PPTX, XLSX, CSV, image OCR when local OCR is configured

render_asset_preview
  PDF page/image thumbnail/document preview for UI

compare_assets
  image dimension diff, PDF text/page diff, spreadsheet schema diff

index_workspace_assets
  build local metadata index for model-readable retrieval
```

### 9.3 Model handoff

The model should receive compact facts, not raw binary blobs:

```text
source path
asset type
extracted text excerpt with caps
visual metadata
page/sheet/frame references
confidence and extraction warnings
```

## 10. UI Event Protocol

A local graphical UI should not guess by scraping logs. It should subscribe to structured events.

```ts
type UiEvent =
  | { type: "workspace.state"; workspaceId: string; state: WorkspaceState }
  | { type: "context.budget"; workspaceId: string; budget: ContextBudget }
  | { type: "context.compaction"; workspaceId: string; status: CompactionStatus }
  | { type: "tool.started"; attempt: RuntimeAttempt }
  | { type: "tool.output_delta"; attemptId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "tool.finished"; attemptId: string; result: ToolResultSummary }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string; decision: ApprovalDecision }
  | { type: "patch.preview"; preview: PatchPreview }
  | { type: "diff.updated"; summary: DiffSummary }
  | { type: "asset.preview"; preview: AssetPreview };
```

Transport options:

```text
MCP Apps widgets for ChatGPT-hosted panels
local WebSocket for DevSpace desktop/web UI
local REST for snapshot reads
SQLite event store for resume/replay
```

## 11. Exceed Codex: Differentiators

Codex owns its terminal/app-server runtime. DevSpace can exceed it because it is explicitly a local API gateway for ChatGPT Web.

### 11.1 Multimodal local project understanding

Codex is strongest on code. DevSpace can become stronger on mixed workspaces:

```text
source code + PDFs + spreadsheets + images + screenshots + docs + generated artifacts
```

### 11.2 Context as a product surface

Do not hide memory. Show it.

```text
what DevSpace remembers
why it remembers it
when it was last updated
which facts are pinned
what will be compacted away
what summary will be sent back to ChatGPT
```

### 11.3 API gateway composability

Expose capabilities through typed APIs, so UI, ChatGPT, and future plugins use the same contract.

```text
MCP tool call
local REST call
local UI event
same underlying runtime event
```

### 11.4 Safer local execution

Use policy and UI to make local execution inspectable:

```text
command intent preview
risk badge
path badge
network badge
approval memory
session audit trail
```

### 11.5 Better resume than ordinary CLI sessions

Resume should be task-aware, not just transcript-aware:

```text
resume by project
resume by branch
resume by task goal
resume by changed files
resume by failed test
resume by pending approval
```

## 12. Implementation Slices

### Slice A: Runtime event store

Files likely to add:

```text
src/runtime/events.ts
src/runtime/event-store.ts
src/runtime/types.ts
src/db/schema.ts
```

Build:

```text
runtime_events table
appendRuntimeEvent()
listRuntimeEvents()
workspace event stream abstraction
```

### Slice B: Tool runtime bus

Files likely to add:

```text
src/runtime/tool-runtime-bus.ts
src/runtime/result.ts
src/policy/tool-policy.ts
```

Build:

```text
common lifecycle wrapper
normalized runtime results
context event recording
UI event emission hooks
```

### Slice C: Policy engine

Files likely to add:

```text
src/policy/command-policy.ts
src/policy/path-policy.ts
src/policy/approval-store.ts
src/policy/rules.ts
```

Build:

```text
command classification
sensitive path denylist
network command classification
approval cache
local rule files
```

### Slice D: Patch-first editing

Files likely to add/change:

```text
src/patch/apply-patch.ts
src/patch/parser.ts
src/patch/safety.ts
src/server.ts
```

Build:

```text
apply_patch tool
patch preview
path approval
exact delta tracking
context events
```

### Slice E: Multimodal gateway

Files likely to add:

```text
src/assets/inspect.ts
src/assets/extract-text.ts
src/assets/preview.ts
src/assets/index.ts
```

Build:

```text
inspect_asset
extract_text
render_asset_preview
index_workspace_assets
```

### Slice F: UI protocol

Files likely to add:

```text
src/ui/events.ts
src/ui/state.ts
src/ui/socket.ts
src/widgets/*
docs/local-agent-ui-design.md
```

Build:

```text
local WebSocket events
MCP widget payloads
approval panel payloads
diff panel payloads
context panel payloads
```

## 13. Evaluation Harness

Create replayable tests that prove DevSpace is becoming Codex-like and beyond-Codex.

### 13.1 Core evals

```text
resume_after_context_compaction
read_modify_review_diff
reject_write_outside_workspace
approve_safe_patch_for_session
classify_dangerous_command
run_check_with_output_cap
rollback_single_patch
summarize_failed_test_into_context
extract_pdf_text_then_patch_code
render_image_metadata_for_model
```

### 13.2 Quality bars

```text
No raw shell write path is required for normal edits.
A new turn can resume from context without rereading the whole repo.
Every write has a diff event and rollback point.
Every command has a policy decision.
Every approval is visible in UI and saved in the event ledger.
Multimodal files produce bounded, source-labeled facts.
```

## 14. Recommended Priority

Do not start with the graphical UI first. Start with the runtime contracts the UI will render.

Recommended order:

```text
1. runtime event store
2. context ledger and projection
3. context compaction tools
4. tool runtime bus
5. command/path policy engine
6. apply_patch tool
7. diff and rollback events
8. local UI event protocol
9. graphical UI shell
10. multimodal asset tools
```

Reason:

```text
A beautiful UI without durable runtime events becomes decorative.
A runtime event protocol makes ChatGPT Web, MCP widgets, and local desktop UI all share the same source of truth.
```

## 15. Definition Of Absorbed

A Codex capability is considered absorbed only when all four layers exist:

```text
contract:
  typed API/tool/event schema exists

runtime:
  behavior is implemented without invoking Codex/Claude as executor

memory:
  action records useful context events and can survive resume

UI:
  user can inspect what happened and approve/reject/rollback when relevant
```

The target is not feature mimicry. The target is operational superiority for ChatGPT-Web-driven local workspaces.
