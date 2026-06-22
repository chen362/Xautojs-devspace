# Local Agent Capability Absorption Plan

Branch: `plan/local-agent-capability-absorption`

Target repository: `chen362/devspace`

Primary reference repository: `chen362/codex`

Secondary reference repository, only where public workflow material is useful: `chen362/claude-code`

Last updated: 2026-06-22

## 0. Executive Decision

DevSpace should become a Codex-style local capability, memory, safety, and UI gateway for ChatGPT Web.

Recommended product architecture:

```text
One shared GPT in ChatGPT Web
  -> one public remote MCP domain
  -> multi-tenant OAuth / OIDC identity
  -> cloud relay / API gateway
  -> each user's own local DevSpace Agent
  -> that user's local project files
```

Core principle:

```text
The GPT can be shared.
The MCP domain can be shared.
But user identity, web conversation bindings, workspace sessions, context memory,
approvals, file permissions, local agents, and audit trails must be isolated per
user, per tenant, per workspace, and per task conversation.
```

Hard product decisions:

```text
Production mode is always multi-user capable.
Production cloud relay uses Postgres as the system database.
SQLite is allowed only for local development, test fixtures, or single-machine demo mode.
DevSpace should not self-build username/password login as the primary identity system.
DevSpace should use a standards-compliant OIDC/OAuth provider for user authentication.
DevSpace acts as the MCP protected resource, resource server, tenant mapper, policy engine, relay gateway, and local-context memory layer.
Workspace Agents API can be used for optional backend-triggered ChatGPT agent runs, but it does not replace MCP relay for live local file work.
```

The target is not to call Codex CLI or Claude Code CLI as another local executor. The target is to absorb the best local-agent runtime capabilities from Codex, implement them inside DevSpace, and then exceed Codex for web-driven multi-user local workspaces.

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

Build and CI decision:

```text
GitHub should build the project directly with npm.
Initial CI lane:
  npm ci
  npm run typecheck
  npm test
  npm run build
Use Node 24 for the main CI lane.
Keep package engine compatibility broad enough for the current project policy, such as >=20.12 <27, unless a dependency forces a narrower range.
Do not introduce a second primary build system before the cloud relay, Postgres boundary, context memory, and local agent runtime are stable.
```

## 1. Conversation And Session Model

There are four different session concepts. They must not be mixed.

```text
ChatGPT chat conversation:
  The user's visible chat thread in ChatGPT Web. DevSpace may not receive a stable native ChatGPT conversation id through MCP, so DevSpace must not depend on it.

Workspace Agent triggered conversation:
  A published ChatGPT Workspace Agent run triggered through OpenAI's Workspace Agents API. This supports caller-defined `conversation_key` for continuing the same agent conversation across trigger events.

DevSpace conversation binding:
  DevSpace's durable mapping between user, task, workspace session, context window, and optional external conversation keys.

DevSpace workspace session:
  The local execution and memory boundary: user + localAgentId + root + worktree/branch + contextWindowId.
```

Default interactive path:

```text
User opens a ChatGPT chat with the shared GPT
  -> ChatGPT calls DevSpace remote MCP tools
  -> DevSpace authenticates the user
  -> DevSpace creates or resumes a conversation binding
  -> DevSpace opens or resumes a workspace session
  -> DevSpace routes local tool calls to the correct local agent
```

Optional backend-trigger path:

```text
External event or DevSpace backend job
  -> POST /v1/workspace_agents/{id}/trigger
  -> input + conversation_key
  -> OpenAI durably queues the trigger event
```

Use Workspace Agents API for scheduled context review, GitHub webhook summaries, failed CI triage, nightly memory refresh, background kickoff, and team automation that does not need immediate response retrieval.

Do not use Workspace Agents trigger as the primary live local-file editing path because the trigger endpoint returns `202 Accepted` without a public run id or retrievable response body.

DevSpace conversation binding fields:

```text
devspaceConversationId
tenantId
userId
localAgentId
workspaceSessionId
contextWindowId
taskGoal
conversationLabel
optional chatgptSurfaceHint
optional workspaceAgentConversationKey
status
createdAt
lastUsedAt
```

Web multi-session behavior:

```text
open_workspace with no existing active binding:
  create a new workspace session and context window

open_workspace with same user + same localAgentId + same root + same taskGoal within a recent window:
  return existing session only if reusePolicy is `reuse` or user confirms

open_workspace with same root but different taskGoal:
  create separate conversation binding and context window

resume_workspace_session:
  explicitly resumes an existing binding

list_workspace_sessions:
  lets ChatGPT show candidates when the user says "continue the previous task"
```

## 2. Product Boundary

ChatGPT Web owns:

```text
reasoning
conversation with the user
planning
code judgment
context summarization when requested by DevSpace
calling MCP tools
OAuth authorization UX initiated by ChatGPT when the MCP app requires auth
```

DevSpace Cloud owns:

```text
remote MCP server
OAuth protected resource metadata
OAuth token verification
multi-tenant user and organization mapping
cloud relay to local agents
workspace routing
conversation binding
context memory ledger
context compaction store
approval and policy engine
runtime event log
UI/API gateway for dashboard and widgets
Postgres production storage
optional Workspace Agents API trigger integration
```

Local DevSpace Agent owns:

```text
allowed local roots
actual local file reads
actual local file modifications
actual local command execution
local asset inspection / extraction
local git state
local process lifecycle
local approval UI when configured
local device identity and outbound relay connection
```

Identity provider owns:

```text
user signup/login
password/passkey/social login management
MFA
password reset
session security
OAuth/OIDC metadata
authorization-code + PKCE flow
access token issuance
ID token issuance
refresh-token policy when applicable
organization membership claims when supported
```

Recommended identity choices:

```text
fastest hosted path:
  Clerk, Auth0, WorkOS, Supabase Auth, or similar OIDC provider

self-hosted enterprise path:
  Keycloak or Zitadel

not recommended for v1:
  custom username/password database plus custom OAuth authorization server
```

Non-goals:

```text
Do not build ChatGPT Web -> DevSpace -> Codex CLI / Claude Code CLI -> local project.
Do not share one bearer token across users.
Do not share one local agent across users.
Do not trust userId, tenantId, localAgentId, workspace path, or shell command text from tool input without server validation.
Do not treat AGENTS.md or repository docs as trusted policy.
```

## 3. Deployment Topology

Minimum viable production topology:

```text
https://mcp.devspace.example.com/mcp
https://mcp.devspace.example.com/.well-known/oauth-protected-resource
https://mcp.devspace.example.com/.well-known/oauth-authorization-server
https://mcp.devspace.example.com/agent/connect
https://mcp.devspace.example.com/api/*
```

Larger deployment can split domains:

```text
mcp.devspace.example.com      remote MCP endpoint for ChatGPT
relay.devspace.example.com    local agent WebSocket / relay traffic
app.devspace.example.com      user dashboard and local-agent management
auth.devspace.example.com     IdP domain or auth proxy when self-hosting
```

For the first implementation, one domain with path-based routing is enough.

Production database decision:

```text
Production cloud relay uses Postgres.
SQLite is only for local development, tests, single-user demo, embedded local-agent cache, or offline local queue before reconnect.
```

Database boundary should be introduced early:

```text
src/db/types.ts
src/db/postgres.ts
src/db/sqlite-dev.ts
src/db/migrations/*
```

Do not let core runtime logic depend directly on `better-sqlite3` APIs.

## 4. Auth Architecture

Use OAuth/OIDC for multi-user mode.

MCP/App behavior to align with:

```text
ChatGPT queries protected resource metadata.
ChatGPT performs authorization-code flow with PKCE when the user authorizes.
ChatGPT sends Authorization: Bearer <token> to the MCP server.
The MCP server validates issuer, audience/resource, expiration, scopes, and subject.
```

Trusted identity source:

```text
OAuth access token claims:
  iss       -> trusted issuer
  sub       -> external user subject
  aud       -> this MCP protected resource
  scope     -> allowed DevSpace capabilities
  org/team  -> optional tenant/org signal when supported
```

DevSpace mapping:

```text
external issuer + external subject -> devspace user_id
external org/team claim or selected workspace -> devspace tenant_id
```

Login UX:

```text
ChatGPT MCP auth:
  ChatGPT opens provider-hosted OAuth page.
  User signs in with IdP.
  ChatGPT receives access token for MCP protected resource.
  DevSpace validates token on every MCP request.

DevSpace web dashboard:
  Show Sign in / Connect account button.
  Redirect to IdP hosted login or secure SDK.
  Do not store passwords in DevSpace.

Local DevSpace Agent:
  Use browser OAuth login with PKCE or device-code flow.
  Register device/agent after login.
  Store only local device credentials and allowed refresh material.
```

Token types:

```text
user access token:
  issued by IdP, accepted by MCP/API gateway, never forwarded to local agents

workspace agent access token:
  provisioned from ChatGPT Admin access-token flow, scoped only to Workspace Agents API operations, stored in secrets manager

local agent device credential:
  minted after authenticated registration, used only for /agent/connect, rotatable/revocable

relay request token/signature:
  short-lived internal envelope from cloud to local agent with requestId, operationId, workspaceSessionId, deadline, and policy summary
```

Recommended OAuth scopes:

```text
devspace:agents:read
devspace:workspace:open
devspace:conversation:read
devspace:conversation:write
devspace:files:read
devspace:files:write
devspace:commands:run
devspace:git:read
devspace:git:write
devspace:context:read
devspace:context:write
devspace:assets:read
devspace:approvals:write
```

## 5. OpenAI Workspace Agents API Alignment

Workspace Agents API is useful, but it is not a replacement for DevSpace MCP relay.

Official behavior to absorb:

```text
POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger

id:
  stable public API trigger identifier for the published API channel, in agtch_XXX form

input:
  required string passed to the agent as trigger input

conversation_key:
  optional caller-defined stable identifier for continuing the same agent conversation across trigger events

Idempotency-Key:
  optional retry key. Same key for same trigger returns original accepted outcome instead of enqueueing duplicate event

response:
  202 Accepted with no response body

current limitation:
  no public run id is returned, and the agent response cannot currently be retrieved through the API
```

Absorb these patterns:

```text
caller-defined conversation_key
idempotency key for retry safety
published-channel trigger id
202 accepted async trigger semantics
separate automation token from user interactive MCP OAuth token
```

Do not copy these assumptions into the live MCP path:

```text
that a trigger response can be read immediately
that Workspace Agent token can access DevSpace local relay
that conversation_key alone identifies a local workspace
that automation triggers can replace interactive MCP tools
```

DevSpace conversation key format:

```text
devspace:v1:{tenantId}:{userId}:{localAgentId}:{workspaceFingerprint}:{taskKey}
```

Never expose raw local paths inside public conversation keys.

Optional Workspace Agent tables:

```sql
workspace_agent_channels(
  id uuid primary key,
  tenant_id uuid not null,
  owner_user_id uuid not null,
  openai_agent_channel_id text not null,
  display_name text not null,
  token_secret_ref text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

workspace_agent_trigger_events(
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  workspace_agent_channel_id uuid not null,
  devspace_conversation_id uuid,
  conversation_key text not null,
  idempotency_key text not null,
  input text not null,
  status text not null,
  accepted_at timestamptz,
  error_code text,
  created_at timestamptz not null,
  unique(workspace_agent_channel_id, idempotency_key)
)
```

## 6. Multi-User Routing Model

Every MCP request must resolve to:

```text
tenantId
userId
devspaceConversationId
localAgentId
workspaceId
workspaceSessionId
contextWindowId
requestId
```

Minimum key for safe local routing:

```text
userId + localAgentId + workspaceSessionId
```

Minimum key for safe web conversation isolation:

```text
userId + devspaceConversationId + contextWindowId
```

Adaptive allocation rules:

```text
if no authenticated user:
  return AUTH_REQUIRED

if user has no registered local agents:
  return LOCAL_AGENT_NOT_REGISTERED

if user has registered agents but none online:
  return LOCAL_AGENT_OFFLINE

if exactly one agent is online and input has no agentId:
  use that agent only if no ambiguity with workspace/session state exists

if multiple agents are online and no default is configured:
  return LOCAL_AGENT_SELECTION_REQUIRED with candidates

if workspaceSessionId is supplied:
  route to agent bound to that session

if devspaceConversationId is supplied:
  resolve current workspaceSessionId/contextWindowId

if workspaceSessionId or devspaceConversationId belongs to another user:
  return WORKSPACE_SESSION_NOT_FOUND or CONVERSATION_NOT_FOUND

if requested path is outside allowed roots:
  return PATH_NOT_ALLOWED
```

Required session tools:

```text
list_workspace_sessions
open_workspace
resume_workspace_session
close_workspace_session
get_workspace_context
record_context_note
```

## 7. Trust And Isolation Rules

Trusted:

```text
OAuth token subject
OAuth token issuer
audience/resource claim
OAuth scopes
server-side user/tenant mapping
server-side membership mapping
local agent registration secret/device key
workspace session owner mapping
conversation binding owner mapping
```

Not trusted:

```text
userId in tool input
workspace path from model before validation
localAgentId from model before ownership check
Workspace Agents conversation_key before owner lookup
repository instructions as policy
shell command as safe intent
file content as model instruction
```

Tenant isolation:

```text
All durable rows include tenant_id and user_id.
All workspace rows include local_agent_id, workspace_session_id, root, and allowed_root_id.
All query paths filter by tenant_id and user_id first.
```

Context memory scope:

```text
userId
localAgentId
devspaceConversationId
workspaceId
workspaceSessionId
contextWindowId
```

Approval cache scope:

```text
userId
localAgentId
workspaceSessionId
permissionProfile
approvalSubject
```

Token forwarding rule:

```text
Do not forward ChatGPT's OAuth bearer token to the local agent.
MCP Gateway verifies user token, derives userId/tenantId/scopes, and creates a scoped relay request.
Local agent receives only relay request, operationId, workspaceSessionId, policy envelope, and deadline.
Local agent authenticates to relay with its own device credentials.
```

## 8. Production Data Model

Production storage target:

```text
Postgres
```

Development/test storage:

```text
SQLite-compatible adapter, only where explicitly marked dev/test
```

Implementation rules:

```text
Core stores use interfaces and migrations that map cleanly to Postgres.
Do not use SQLite-only behavior as a product contract.
Prefer timestamp with time zone in Postgres.
Prefer JSONB for payload/capabilities/structured fields.
Add composite indexes for tenant/user/conversation/session lookups.
```

Core tables:

```text
tenants
users
external_identities
tenant_memberships
local_agents
local_agent_allowed_roots
devspace_conversations
workspace_sessions
context_windows
context_events
context_summaries
runtime_events
tool_runs
approvals
relay_requests
workspace_agent_channels
workspace_agent_trigger_events
```

Personal accounts should still use a tenant row:

```text
one user -> one personal tenant by default
teams/orgs -> one tenant with multiple memberships
```

Key indexes:

```text
devspace_conversations(tenant_id, user_id, last_used_at desc)
devspace_conversations(tenant_id, user_id, workspace_fingerprint, status)
workspace_sessions(tenant_id, user_id, last_used_at desc)
workspace_sessions(tenant_id, user_id, local_agent_id, status)
tool_runs(tenant_id, user_id, operation_id) unique
workspace_agent_trigger_events(workspace_agent_channel_id, idempotency_key) unique
```

## 9. API Contract: Remote MCP Tools

All tools are called by ChatGPT through the shared remote MCP server.

Common rules:

```text
Authentication:
  required OAuth bearer token in multi-user mode

Identity:
  derived from token, never from body

Idempotency:
  mutation tools require operationId or derive one from MCP tool call id + input fingerprint

Conversation:
  local work should use devspaceConversationId after one is created or resumed

Workspace:
  local workspace tools require workspaceSessionId after open_workspace

Errors:
  use stable machine-readable error codes
```

Unified response envelope:

```ts
interface ToolResponse<T = unknown> {
  result: string;
  data?: T;
  meta: {
    requestId: string;
    devspaceConversationId?: string;
    workspaceSessionId?: string;
    contextWindowId?: string;
    operationId?: string;
    estimatedTokens?: number;
    eventsRecorded?: number;
    compactionRecommended?: boolean;
  };
}
```

Unified error model:

```ts
interface DevSpaceError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    retryable: boolean;
  };
}
```

Required error codes:

```text
AUTH_REQUIRED
TOKEN_INVALID
TOKEN_EXPIRED
TOKEN_AUDIENCE_INVALID
TOKEN_SCOPE_MISSING
TENANT_DISABLED
USER_DISABLED
CONVERSATION_NOT_FOUND
CONVERSATION_SELECTION_REQUIRED
LOCAL_AGENT_NOT_REGISTERED
LOCAL_AGENT_OFFLINE
LOCAL_AGENT_SELECTION_REQUIRED
LOCAL_AGENT_VERSION_UNSUPPORTED
WORKSPACE_SESSION_NOT_FOUND
WORKSPACE_NOT_OPEN
PATH_NOT_ALLOWED
PATH_OUTSIDE_WORKSPACE
PATH_DENIED_SECRET
CONTEXT_WINDOW_NOT_FOUND
CONTEXT_BUDGET_EXCEEDED
CONTEXT_SUMMARY_REQUIRED
CONTEXT_SUMMARY_INVALID
APPROVAL_REQUIRED
APPROVAL_DENIED
COMMAND_FORBIDDEN
COMMAND_TIMEOUT
COMMAND_OUTPUT_TRUNCATED
NETWORK_FORBIDDEN
PATCH_INVALID
PATCH_REJECTED
PATCH_CONFLICT
ROLLBACK_NOT_AVAILABLE
ASSET_UNSUPPORTED
ASSET_EXTRACTION_FAILED
RELAY_TIMEOUT
RELAY_DELIVERY_FAILED
WORKSPACE_AGENT_TRIGGER_FAILED
IDEMPOTENCY_CONFLICT
INTERNAL_ERROR
```

Conversation tools:

```text
list_workspace_sessions
open_workspace
resume_workspace_session
close_workspace_session
get_workspace_context
record_context_note
```

Local agent tools:

```text
list_local_agents
get_local_agent_status
```

File, patch, command, git, and asset tools:

```text
read_file
list_directory
search_workspace
find_files
apply_patch
run_check
run_command
run_shell
start_server
stop_server
git_status
git_diff
git_log
show_changes
list_changed_files
show_file_diff
rollback_changes
mark_reviewed
inspect_asset
extract_text
render_asset_preview
compare_assets
index_workspace_assets
```

Tool rules:

```text
read tools are path-validated
large files return bounded excerpts or chunk refs
patch is preferred for writes
commands are policy-gated and output-capped
all writes and command runs record context and runtime events
all risky actions require approval
```

## 10. Local Agent Relay Contract

Local agent opens outbound WebSocket:

```text
GET /agent/connect
Authorization: Bearer <agent-device-token>
```

Connection hello:

```ts
interface AgentHello {
  type: "agent.hello";
  localAgentId: string;
  version: string;
  hostname: string;
  platform: string;
  capabilities: string[];
  allowedRoots: Array<{
    rootId: string;
    path: string;
    label?: string;
    read: boolean;
    write: boolean;
    execute: boolean;
  }>;
}
```

Relay request envelope:

```ts
interface RelayRequest {
  type: "relay.request";
  requestId: string;
  operationId: string;
  tenantId: string;
  userId: string;
  devspaceConversationId?: string;
  workspaceSessionId?: string;
  method: string;
  params: Record<string, unknown>;
  deadlineMs: number;
  trace: {
    mcpRequestId: string;
    toolName: string;
  };
}
```

Delivery semantics:

```text
Relay delivery is at-least-once under reconnect/timeouts.
Local agent must dedupe by operationId + input fingerprint for mutations.
Read tools may be retried freely.
Write tools must be idempotent or return conflict.
Long-running commands must expose status and cancellation.
```

## 11. Context Memory And Compaction Design

This remains the highest-value capability to absorb from Codex.

Codex behavior to absorb:

```text
raw history
prompt-ready history
history versioning
token usage tracking
function/tool output truncation
call/output pair normalization
rollback-aware trimming
source-labeled context fragments
manual compaction
auto compaction
remote compaction
pre/post compaction hooks
rollout/session metadata
archived session lookup
memory generation flag
```

DevSpace translation:

```text
raw event ledger
model-ready context projection
UI-ready context projection
context versioning
conversation-scoped context windows
pinned facts
compaction requests
summary validation
resume summaries
project/task memory
```

Required event types:

```text
workspace_opened
conversation_bound
user_task
agents_instructions_loaded
skill_loaded
file_read
search_performed
asset_inspected
asset_text_extracted
file_relevance_note
command_run
command_output_summary
test_result
patch_previewed
patch_applied
diff_summary
approval_requested
approval_resolved
assumption
decision
risk
next_step
manual_note
context_projection_requested
context_compaction_requested
context_compaction_saved
rollback_applied
workspace_agent_triggered
```

A compacted summary must preserve:

```text
user goal
current task state
important constraints
important decisions
assumptions
files read
files changed
test/build results
open risks
next steps
pinned facts
approval decisions still in force
conversation binding identity
```

DevSpace cannot rewrite ChatGPT Web's native conversation history. It can only maintain local project/session context and expose compact model-ready projections through MCP tools, server instructions, and widgets.

## 12. Codex Deep Capability Absorption

Tool runtime bus:

```text
approval
sandbox/profile selection
first attempt
network approval handling
sandbox denial handling
retry/escalation logic
telemetry/event recording
final structured result
```

Approval store:

```text
approve once
approve for session
approve matching command prefix
approve matching path set
approve network host
reject and remember
```

Approval keys include:

```text
userId + localAgentId + workspaceSessionId + permissionProfile + approvalSubjectFingerprint
```

Command policy engine:

```text
rule files
allow/prompt/forbid decisions
safe command heuristics
dangerous command heuristics
prefix rule amendments
network rule amendments
policy parse warnings
approval policy conflict handling
```

Forbidden by default:

```text
credential reads
SSH key reads
cloud secret commands
rm -rf broad paths
git reset --hard
git clean -fdx
chmod/chown broad paths
unknown shell scripts that hide writes
commands outside workspace
```

Patch-first editing:

```text
explicit patch invocation
parse patch
validate patch grammar
resolve paths
reject empty patches
reject writes outside workspace
ask approval for risky writes
auto-approve constrained workspace writes when policy allows
record exact applied delta
handle partial failure with committed delta information
convert patch to protocol-level file changes
```

Preferred write order:

```text
apply_patch > edit_file > write_file > shell writes
```

Turn diff tracker:

```text
track exact patch deltas during a turn
render current diff without rereading everything
handle adds/deletes/updates/renames
cache rendered diffs
invalidate when exactness is lost
```

Bounded command execution:

```text
default timeout
explicit timeout
cancellation token
stdout/stderr streaming deltas
output byte caps
I/O drain timeout
process group termination
structured exit status
timeout exit classification
```

Session and rollout archive:

```text
thread/session metadata
archived sessions
summary reads
session lookup
memory generation option
resume hints
```

Resume dimensions:

```text
resume by project
resume by web conversation binding
resume by workspace session
resume by branch
resume by task goal
resume by changed files
resume by failed check
resume by pending approval
```

Config layers, hooks, and workflow packs:

```text
user config
team config
project config
trusted vs untrusted project rules
permission profile constraints
warnings when policy files fail to parse
SessionStart
PreToolUse
PostToolUse
PermissionRequest
PreCompact
PostCompact
Stop
SessionEnd
feature-dev workflow pack
code-review workflow pack
security-guidance workflow pack
commit-workflow pack
```

Project instructions can guide behavior but must not override safety policy.

Multimodal local gateway beyond Codex:

```text
code + PDFs + images + screenshots + spreadsheets + Office docs + generated artifacts
metadata inspection
PDF text extraction
PDF page rendering
DOCX/PPTX text extraction
XLSX/CSV schema extraction
image metadata and OCR when configured
asset diff and preview generation
```

Return compact facts to ChatGPT, not unbounded raw binary data.

## 13. UI / Workbench Design

The UI is the local command center for:

```text
connection status
workspace state
web conversation bindings
context memory
approvals
tool runs
diffs
rollback
asset previews
settings
```

Default layout:

```text
+--------------------------------------------------------------------------------+
| Top Bar: Workspace / Branch / MCP Status / Context Budget / Safety Mode         |
+-------------+----------------------------+-------------------------------+-----+
| Left Rail   | Session + Task Sidebar     | Main Task Thread              |Right|
| - Workspace | - Active conversation      | - ChatGPT actions             |Pane |
| - Context   | - Recent sessions          | - Tool cards                  |     |
| - Changes   | - Pending approvals        | - Output streams              |     |
| - Runs      | - Failed checks            | - Assistant notes             |     |
| - Assets    | - Pinned memories          | - User interventions          |     |
| - Settings  |                            |                               |     |
+-------------+----------------------------+-------------------------------+-----+
| Composer / Command Bar / Attachments / Mode Switch / Send                       |
+--------------------------------------------------------------------------------+
```

Required panels:

```text
Workspace panel
Conversation/session picker
Context memory panel
Change review panel
Approval queue panel
Run output panel
Asset preview panel
Settings panel
Workspace Agent trigger log panel
```

Event card types:

```text
UserRequestCard
AssistantPlanCard
ConversationBoundCard
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
WorkspaceAgentTriggerCard
RollbackCard
ErrorCard
```

## 14. Security Model

Main risks:

```text
cross-user data leak
wrong web conversation binding
wrong local agent routing
workspace path escape
symlink/hardlink escape
secret file read
prompt injection from repository content
malicious AGENTS.md
unsafe shell command
network exfiltration
unbounded output or file read
stale approval reuse
compaction summary losing critical safety facts
local agent token theft
relay replay attack
IdP token audience confusion
Workspace Agent token misuse
accidental forwarding of user OAuth token to local agent
SQLite single-file assumptions leaking into production multi-user design
```

Required mitigations:

```text
OAuth token validation on every MCP request
issuer validation
audience/resource validation
scope validation
per-user local agent ownership checks
devspaceConversationId ownership checks
workspaceSessionId ownership checks
allowed root validation in cloud and local agent
path normalization before access
sensitive path denylist
patch safety before writes
command policy before execution
approval isolation per user/session
operationId dedupe for mutations
Idempotency-Key for Workspace Agent trigger retries
short-lived relay request deadlines
agent heartbeat and version checks
audit log for all writes/commands/approvals/triggers
context summary validation
output caps and file-size caps
Postgres production storage with tenant/user indexes
no forwarding user bearer token to local agent
secrets manager for Workspace Agent access tokens
```

## 15. Implementation Roadmap

Phase 0: Consolidate planning

```text
single source-of-truth plan exists
language/runtime decision is frozen
multi-user relay architecture is defined
web multi-session model is defined
Workspace Agents API optional role is defined
production auth provider decision is defined
Postgres-first multi-user storage decision is defined
Codex absorption scope is defined
```

Phase 1: Auth provider integration and protected MCP resource

```text
OIDC provider config
OAuth protected resource metadata
authorization server metadata integration
JWKS/token verification middleware
issuer/audience/scope checks
external identity to user/tenant mapping
requestId generation
unified error model
Postgres database adapter boundary
SQLite dev adapter boundary
```

Phase 2: Local agent registration and relay

```text
local agent registration
agent token/device key
outbound WebSocket connection
heartbeat
capability advertisement
allowed root advertisement
relay request/response envelope
operationId dedupe foundation
```

Phase 3: Conversation binding and workspace routing

```text
devspace_conversations table
list_workspace_sessions
open_workspace with devspaceConversationId/localAgentId
resume_workspace_session
close_workspace_session
canonical path validation
allowed root binding
workspaceSessionId generation
contextWindowId generation
sticky routing
multi-agent selection errors
```

Phase 4: Context ledger core

```text
context_windows
context_events
context_pins
record_context_note
get_workspace_context
projection modes
source-labeled output
conversation-scoped context
```

Phase 5: Context compaction

```text
prepare_context_compaction
save_context_summary
required field validation
summary source range tracking
pinned fact preservation
compaction recommendation
```

Phase 6: Runtime event store and UI protocol

```text
runtime_events table
appendRuntimeEvent
listRuntimeEvents
UI event envelope
WebSocket or SSE stream for local UI
MCP widget payload alignment
```

Phase 7: Tool runtime bus

```text
wrap all tools in common lifecycle
classify risk
record operationId
record tool run
record context events
emit UI events
normalize errors
```

Phase 8: Policy and approvals

```text
command classification
safe/danger heuristics
path denylist
network command detection
approval request model
approval cache
approve once/session
policy rule amendments
```

Phase 9: Patch-first editing

```text
apply_patch tool
patch parser/validator
path safety
approval integration
exact delta tracking
context events
show_changes integration
```

Phase 10: Command execution profiles

```text
run_check
run_command
start_server
stop_server
timeouts
cancellation
output caps
stdout/stderr stream events
exit classification
```

Phase 11: Diff and rollback

```text
per-task diff
since-open diff
file diff
rollback file
rollback patch operation
rollback managed worktree
mark reviewed
```

Phase 12: Workspace Agents optional automation integration

```text
workspace_agent_channels table
workspace_agent_trigger_events table
secrets manager token reference
trigger workspace agent helper
conversation_key generator
idempotency key support
trigger audit log
clear documentation that accepted trigger does not return agent answer
```

Phase 13: Multimodal local asset gateway

```text
inspect_asset
extract_text
render_asset_preview
compare_assets
index_workspace_assets
bounded extraction
source-labeled asset facts
```

Phase 14: Graphical workbench

```text
workbench shell
task thread
conversation/session picker
context panel
diff panel
approval queue
run output panel
asset preview panel
Workspace Agent trigger log panel
settings panel
```

Phase 15: Workflow packs and hooks

```text
hook lifecycle
workflow pack manifest
feature-dev pack
code-review pack
security-guidance pack
commit-workflow pack
hierarchical AGENTS.md loading
```

Phase 16: Evaluation and hardening

```text
replayable local-agent scenarios
multi-user isolation tests
multi-conversation isolation tests
context resume tests
patch safety tests
command policy tests
asset extraction tests
relay timeout tests
Workspace Agent trigger idempotency tests
```

## 16. Recommended PR Sequence

```text
PR 1: auth provider integration + protected MCP resource + Postgres boundary
PR 2: local agent registration + outbound relay ping
PR 3: conversation binding + open_workspace routing through relay
PR 4: list/resume/close workspace sessions
PR 5: context ledger core + get_workspace_context
PR 6: context compaction tools + summary validation
PR 7: runtime event store + UI event protocol
PR 8: tool runtime bus wrapping existing tools
PR 9: policy engine + approval store
PR 10: apply_patch tool + patch safety
PR 11: run_check/run_command with caps/cancel
PR 12: diff/rollback expansion
PR 13: optional Workspace Agents trigger integration
PR 14: multimodal asset tools
PR 15: graphical workbench MVP
PR 16: hooks/workflow packs
PR 17: eval suite and hardening
```

Do not start with graphical UI first. The UI should render runtime events; it should not invent state by scraping logs.

## 17. End-To-End User Flows

First user setup:

```text
1. User adds shared GPT in ChatGPT.
2. User invokes DevSpace tool.
3. ChatGPT launches OAuth.
4. User signs in through IdP hosted login and grants scopes.
5. User installs/runs local DevSpace Agent.
6. Local Agent runs browser/device-code login.
7. Local Agent registers and connects outbound.
8. ChatGPT calls list_local_agents.
9. ChatGPT calls open_workspace.
10. DevSpace returns devspaceConversationId/workspaceSessionId/contextWindowId.
11. User starts local coding task.
```

Normal coding task:

```text
1. get_workspace_context
2. read_file/search_workspace/list_directory
3. record decisions/assumptions
4. apply_patch
5. run_check
6. show_changes
7. prepare_context_compaction if needed
8. save_context_summary
```

Resume next day:

```text
1. User says: continue yesterday's DevSpace MCP refactor.
2. ChatGPT calls list_workspace_sessions.
3. DevSpace returns candidate devspaceConversationId/workspaceSessionId rows.
4. ChatGPT asks user to pick if ambiguous.
5. ChatGPT calls resume_workspace_session.
6. DevSpace returns goal, summary, decisions, touched files, last tests, risks, next steps.
7. ChatGPT continues without rereading the whole repo.
```

Multiple web chats same workspace:

```text
1. User opens Chat A for feature work.
2. open_workspace creates conversation A and context window A.
3. User opens Chat B for code review on same root.
4. open_workspace with different taskGoal creates conversation B and context window B.
5. Both share same local agent/root but maintain separate task memory and approvals unless explicitly scoped wider.
```

Workspace Agent backend trigger:

```text
1. CI failure event arrives in DevSpace backend.
2. DevSpace computes conversation_key for tenant/user/workspace/task.
3. DevSpace sends trigger to OpenAI Workspace Agents API with input and Idempotency-Key.
4. OpenAI returns 202 Accepted.
5. DevSpace records trigger event.
6. DevSpace does not assume an agent answer is retrievable through the trigger API.
```

## 18. Acceptance Criteria

The system is successful when:

```text
same GPT can serve multiple users safely
one MCP domain can route to many local agents
production cloud mode uses Postgres
SQLite is limited to dev/test/local demo mode
user auth uses OIDC/OAuth provider instead of custom password storage
primary product language is TypeScript
primary runtime is Node.js
local agent v1 is TypeScript + Node.js
Rust is only optional sidecar work
GitHub can build the project with npm-based CI
user A can never access user B's files, context, approvals, or local agents
same user can run multiple isolated web conversations against the same workspace
ChatGPT can list/resume/close DevSpace workspace sessions
ChatGPT can open a local workspace through MCP
ChatGPT can retrieve compact workspace context
ChatGPT can patch local files without invoking Codex CLI
ChatGPT can run tests/checks with output caps and cancellation
user can review diffs and rollback changes
context survives across turns and future sessions
compaction preserves important state
Workspace Agents API is used only for optional async backend triggers unless future response retrieval changes the product boundary
multimodal assets can be inspected locally and summarized safely
local UI shows memory, runs, approvals, diffs, assets, and conversation bindings
all risky actions are auditable
```

## 19. Current DevSpace Baseline

Observed from `chen362/devspace`:

```text
package.json:
  TypeScript + Node.js project
  React/Vite frontend build
  npm build/typecheck/test scripts
  Node engine supports modern Node versions

src/server.ts:
  Streamable HTTP MCP server, OAuth-protected endpoint, tool registration, widgets, server instructions

src/pi-tools.ts:
  wraps @earendil-works/pi-coding-agent tools for read/write/edit/grep/find/ls/bash

src/roots.ts:
  allowed root containment

src/workspaces.ts:
  checkout/worktree sessions, workspace IDs, AGENTS/CLAUDE.md discovery, skills, path resolution

src/git-worktrees.ts:
  isolated managed git worktrees

src/review-checkpoints.ts:
  git snapshot review and show_changes

src/workspace-store.ts:
  SQLite workspace sessions

src/db/client.ts and src/db/schema.ts:
  current state is SQLite-first and must be abstracted before production multi-user cloud relay
```

Missing layers:

```text
OIDC/OAuth provider integration
Postgres production storage
multi-user cloud relay
web conversation binding
per-user local agent routing
context ledger
compaction
runtime event store
tool runtime bus
policy/approval engine
patch-first edit engine
bounded command runtime
optional Workspace Agents trigger integration
multimodal asset gateway
local workbench UI
```

## 20. Source Notes

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
src/db/client.ts
src/db/schema.ts
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
codex-rs/apply-patch/src/lib.rs
codex-rs/core/src/tools/orchestrator.rs
codex-rs/core/src/tools/sandboxing.rs
codex-rs/core/src/exec_policy.rs
codex-rs/core/src/safety.rs
codex-rs/core/src/turn_diff_tracker.rs
codex-rs/core/src/exec.rs
codex-rs/tui/src/chatwidget.rs
codex-rs/tui/src/app.rs
codex-rs/app-server/src/lib.rs
docs/config.md
```

Claude Code public materials reviewed only as workflow inspiration:

```text
README.md
plugins/README.md
.claude-plugin/marketplace.json
plugins/feature-dev/README.md
plugins/commit-commands/README.md
plugins/security-guidance/README.md
plugins/plugin-dev/README.md
```

OpenAI public docs consulted:

```text
Remote MCP / Apps auth:
  https://developers.openai.com/api/docs/mcp
  https://developers.openai.com/apps-sdk/build/auth
  https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

Workspace Agents:
  https://developers.openai.com/workspace-agents/trigger-runs
  https://developers.openai.com/workspace-agents/authentication
```
