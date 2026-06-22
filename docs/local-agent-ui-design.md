# Local Agent UI Design

Branch: `plan/local-agent-capability-absorption`

Companion docs:

- `docs/local-agent-capability-absorption-plan.md`
- `docs/local-agent-codex-deep-absorption.md`

## 1. Product Intention

Build a local graphical UI for DevSpace that feels like a Codex desktop/local-agent workbench, but is designed for this architecture:

```text
ChatGPT Web
  -> MCP
  -> DevSpace local API gateway
  -> local workspace files, git, shell, assets, context memory, approvals
```

The UI is not the model. The UI is the user's local command center for seeing, approving, reviewing, resuming, and correcting what the web model is doing through DevSpace.

## 2. Visual Thesis

A quiet local engineering cockpit: dense, inspectable, fast, and calm. The interface should show a live task thread in the center, local project state at the edges, and confidence/safety signals everywhere an action can touch files or commands.

Avoid a marketing dashboard. This is an operational tool for repeated use.

## 3. Core UI Jobs

The UI must make these jobs obvious:

```text
connect a local workspace
see what ChatGPT is doing through MCP
inspect what DevSpace remembers
approve or deny risky local actions
review file changes before accepting them
run and monitor checks
resume previous local tasks
open multimodal local assets and extracted facts
rollback local changes when needed
```

## 4. Information Architecture

### 4.1 App shell

```text
+--------------------------------------------------------------------------------+
| Top Bar: Workspace / Branch / MCP Status / Context Budget / Safety Mode         |
+-------------+----------------------------+-------------------------------+-----+
| Left Rail   | Session + Task Sidebar     | Main Task Thread              |     |
|             |                            |                               |Right|
| - Workspaces| - Active task              | - ChatGPT actions             |Pane |
| - Context   | - Recent sessions          | - Tool cards                  |     |
| - Changes   | - Pending approvals        | - Output streams              |     |
| - Runs      | - Failed checks            | - Assistant notes             |     |
| - Assets    | - Pinned memories          | - User interventions          |     |
| - Settings  |                            |                               |     |
+-------------+----------------------------+-------------------------------+-----+
| Composer / Command Bar / Attachments / Mode Switch / Send                       |
+--------------------------------------------------------------------------------+
```

The default screen should be the usable task workbench, not a landing page.

### 4.2 Primary regions

| Region | Purpose |
| --- | --- |
| Top bar | Global local state: workspace, branch, MCP connection, context budget, safety mode |
| Left rail | High-level product sections |
| Session sidebar | Task/session navigation and recovery |
| Main thread | Chronological event stream of model requests and local tool actions |
| Right inspector | Context, diff, file, approval, asset, and run details |
| Composer | Local instruction input and quick command routing |

## 5. Navigation Model

### Left rail sections

```text
Workspace
Context
Changes
Runs
Assets
Approvals
Settings
```

### Workspace section

Shows:

```text
current root
allowed roots
branch/worktree mode
AGENTS.md / CLAUDE.md status
loaded skills/workflow packs
MCP tunnel/URL status
last activity
```

### Context section

Shows:

```text
current goal
active task summary
context budget meter
compaction recommendation
pinned facts
decisions
assumptions
open questions
files read
files changed
latest tests
```

### Changes section

Shows:

```text
changed file list
semantic groups: code, tests, docs, config, generated
unified diff
hunk-level comments
rollback points
accept/mark reviewed
```

### Runs section

Shows:

```text
running commands
recent checks
stdout/stderr streams
exit codes
timeouts
retry recommendations
server processes
```

### Assets section

Shows:

```text
images
PDFs
Office docs
spreadsheets
archives
binary metadata
extracted text/OCR facts
asset previews
```

### Approvals section

Shows:

```text
pending risky actions
approved-for-session items
rejected actions
rule amendments
network approvals
path approvals
```

## 6. Main Task Thread

The center thread should behave like a local-agent transcript, but every local action should be structured as a card.

### 6.1 Event card types

```text
UserRequestCard
AssistantPlanCard
WorkspaceOpenCard
ContextProjectionCard
FileReadCard
SearchCard
AssetInspectCard
PatchPreviewCard
PatchAppliedCard
CommandRunCard
ApprovalRequestCard
DiffReviewCard
TestResultCard
CompactionCard
RollbackCard
ErrorCard
```

### 6.2 Tool card states

```text
queued
running
needs_approval
approved
rejected
succeeded
failed
cancelled
compacted
rolled_back
```

### 6.3 Tool card anatomy

```text
title: action and target
subtitle: workspace/path/command
risk badge: read/write/execute/network/destructive
status badge: running/succeeded/failed
summary: model-readable result in human form
details disclosure: raw output, args, policy decision, context events
actions: approve, deny, view diff, rerun, copy command, rollback
```

## 7. Right Inspector Panels

The right pane changes based on selected card or current nav section.

### 7.1 Context inspector

```text
Current Goal
Task Summary
Pinned Facts
Decisions
Open Questions
Relevant Files
Recent Events
Compaction Preview
```

Actions:

```text
pin fact
unpin fact
edit local note
request compaction
save model summary
show raw events
```

### 7.2 Diff inspector

```text
Changed Files
Diff Stats
Unified Diff
Hunk List
Rollback Point
Test Recommendation
```

Actions:

```text
mark reviewed
rollback file
rollback task
copy patch
open file
```

### 7.3 Approval inspector

```text
Action
Reason
Risk
Affected Paths
Command
Network Host
Policy Decision
Prior Approvals
Suggested Rule Amendment
```

Actions:

```text
approve once
approve for session
deny
deny and remember
edit rule
```

### 7.4 Asset inspector

```text
Preview
Metadata
Extracted Text
OCR Warnings
Page/Sheet/Frame References
Related Context Facts
```

Actions:

```text
extract text
render preview
pin fact
compare asset
open externally
```

## 8. Composer Design

The bottom composer should support natural requests and local routing controls.

### 8.1 Composer controls

```text
text input
workspace selector
mode selector: Ask, Plan, Edit, Review, Run Check
attachment picker
context include toggle
approval mode selector
send button
```

### 8.2 Quick commands

Use slash-command-like commands, inspired by Codex/Claude workflow affordances but implemented in DevSpace:

```text
/open <path>
/context
/compact
/changes
/run <command>
/check
/rollback
/assets
/approvals
/settings
```

These are UI conveniences. They should call the same local APIs that MCP tools call.

## 9. Context Memory UI

Context must be visible and editable enough for trust.

### 9.1 Context budget meter

Show:

```text
estimated tokens or bytes
recent tail size
summary size
pinned facts size
compaction threshold
last compaction time
```

States:

```text
healthy
watch
compaction_recommended
summary_required
```

### 9.2 Memory map

A compact graph/list of what DevSpace remembers:

```text
Goal
Decisions
Assumptions
Risks
Files
Symbols
API Contracts
Tests
Assets
Next Steps
```

Each item should show source and freshness:

```text
source: user | tool | summary | manual note
updated: timestamp
confidence: exact | summarized | inferred
```

### 9.3 Compaction flow

```text
1. UI shows compaction recommended.
2. User clicks Prepare Compaction.
3. DevSpace calls prepare_context_compaction.
4. ChatGPT Web summarizes with required fields.
5. DevSpace validates summary.
6. UI shows before/after preview.
7. User or model saves summary through save_context_summary.
8. Context ledger records compaction event.
```

## 10. Safety UX

Safety should be clear but not theatrical.

### 10.1 Badges

```text
Read
Write
Execute
Network
Sensitive Path
Destructive
Needs Approval
Approved For Session
Sandboxed
Unsandboxed
```

### 10.2 Approval copy

Approval prompts must answer:

```text
What will happen?
Which files or commands are affected?
Why is approval needed?
What is the worst realistic risk?
Will this approval apply once or for the session?
```

### 10.3 Dangerous actions

For destructive actions, require an explicit confirmation step in the UI even if MCP approval is requested.

Examples:

```text
git reset --hard
rm -rf
write outside workspace
read known secret paths
network install or fetch
```

## 11. Multimodal UI

DevSpace should expose local asset understanding as a visible product surface.

### 11.1 Asset grid

Each asset card shows:

```text
thumbnail or type icon
path
mime type
size
last modified
extraction status
linked task/context facts
```

### 11.2 Asset detail

For images:

```text
preview
dimensions
color mode
OCR text when available
model notes/pins
```

For PDFs:

```text
page previews
page count
text extraction
OCR status
outline/headings when available
```

For spreadsheets:

```text
sheet list
row/column counts
schema preview
formula presence
chart/table detection when available
```

### 11.3 Model handoff panel

Show the exact compact facts that would be sent back to ChatGPT:

```text
path
asset kind
summary
extracted snippets
warnings
references
```

## 12. Local API For UI

The UI should consume a local API, not scrape MCP responses.

### 12.1 REST snapshot endpoints

```text
GET /api/workspaces
GET /api/workspaces/:workspaceId
GET /api/workspaces/:workspaceId/context
GET /api/workspaces/:workspaceId/events
GET /api/workspaces/:workspaceId/changes
GET /api/workspaces/:workspaceId/runs
GET /api/workspaces/:workspaceId/assets
GET /api/workspaces/:workspaceId/approvals
```

### 12.2 Mutation endpoints

```text
POST /api/workspaces/:workspaceId/context/notes
POST /api/workspaces/:workspaceId/context/compact/prepare
POST /api/workspaces/:workspaceId/context/compact/save
POST /api/workspaces/:workspaceId/approvals/:approvalId/approve
POST /api/workspaces/:workspaceId/approvals/:approvalId/deny
POST /api/workspaces/:workspaceId/changes/rollback
POST /api/workspaces/:workspaceId/runs/:runId/cancel
POST /api/workspaces/:workspaceId/assets/:assetId/extract-text
```

### 12.3 WebSocket events

```text
workspace.state
context.updated
context.budget
context.compaction
tool.started
tool.output_delta
tool.finished
approval.requested
approval.resolved
diff.updated
asset.preview
run.process_started
run.process_stopped
error
```

## 13. MVP Screens

### Screen 1: Workbench

Default view.

Must show:

```text
active workspace
main task thread
composer
context budget
current diff summary
MCP connection status
```

### Screen 2: Context Memory

Must show:

```text
goal
summary
decisions
assumptions
open questions
files touched
compaction preview
pins
```

### Screen 3: Change Review

Must show:

```text
changed files
stats
unified diff
rollback actions
test status
```

### Screen 4: Approval Queue

Must show:

```text
pending approvals
risk explanation
affected path/command/network host
approve/deny choices
approval memory
```

### Screen 5: Runs

Must show:

```text
active checks
command output streams
exit code
duration
timeouts/cancel
```

### Screen 6: Assets

Must show:

```text
local asset list
preview
metadata
extracted text
context facts
```

## 14. Component Inventory

```text
AppShell
TopStatusBar
WorkspaceSwitcher
McpConnectionBadge
ContextBudgetMeter
SafetyModeBadge
SessionSidebar
TaskList
PendingApprovalList
PinnedMemoryList
TaskThread
ToolRunCard
ApprovalCard
DiffSummaryCard
PatchPreviewCard
CommandOutputCard
CompactionCard
RightInspector
ContextMemoryPanel
DiffReviewPanel
ApprovalPanel
AssetPreviewPanel
RunDetailsPanel
Composer
CommandPalette
SettingsPanel
```

## 15. Design Rules

```text
Use dense but readable operational layout.
Use cards only for individual events or tool calls.
Do not nest cards.
Do not create a marketing hero.
Keep colors restrained: neutral base, one accent, clear status colors.
Prefer icons for common actions: approve, deny, retry, rollback, open, pin, compact.
Every risky local action must show a risk badge.
Every write must be reviewable.
Every remembered fact must have a source.
Every compaction must have a before/after preview.
```

## 16. Responsive Behavior

Desktop-first, but not desktop-only.

```text
wide desktop:
  left rail + sidebar + thread + right inspector

laptop:
  collapsible sidebar and inspector

tablet:
  left rail hidden behind menu, inspector as drawer

mobile:
  read-only monitoring and approvals; heavy diff editing can be limited
```

## 17. MVP Build Order

```text
1. event protocol and mock data
2. workbench shell
3. task thread with tool cards
4. context memory panel
5. diff review panel
6. approval queue panel
7. run output panel
8. asset preview panel
9. settings and MCP connection panel
```

The UI should be implemented after the runtime event protocol exists. Otherwise it will become a static shell with no reliable source of truth.

## 18. Acceptance Criteria

The UI is successful when the user can answer these questions at a glance:

```text
Which workspace is connected?
What is ChatGPT doing locally right now?
What did it read or change?
What does DevSpace remember?
Is context compaction needed?
Which actions need approval?
What changed in git?
Did tests pass?
Can I rollback safely?
What local assets were inspected or extracted?
```

If those questions are visible without opening raw logs, the UI is doing its job.
