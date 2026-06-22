# Local Agent Capability Absorption Plan

Branch: `plan/local-agent-capability-absorption`

Target repository: `chen362/devspace`

Primary reference repository: `chen362/codex`

Secondary reference repository, only where public workflow material is useful: `chen362/claude-code`

Last updated: 2026-06-22

## 0. Executive Decision

DevSpace should become a Codex-style local capability, memory, safety, and UI gateway for ChatGPT Web.

The recommended product architecture is:

```text
One shared GPT in ChatGPT Web
  -> one public remote MCP domain
  -> multi-tenant OAuth / OIDC identity
  -> cloud relay / API gateway
  -> each user's own local DevSpace Agent
  -> that user's local project files
```

The core principle is:

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
DevSpace itself acts as the MCP protected resource, resource server, tenant mapper, policy engine, relay gateway, and local-context memory layer.
Workspace Agents API can be used for optional backend-triggered ChatGPT agent runs, but it does not replace MCP relay for live local file work.
```

The target is not to call Codex CLI or Claude Code CLI as another local executor. The target is to absorb the best local-agent runtime capabilities from Codex, implement them inside DevSpace, and then exceed Codex for web-driven multi-user local workspaces.

## 1. Conversation And Session Model

This is the most important correction for web-side multi-session behavior.

There are four different session concepts. They must not be mixed.

```text
ChatGPT chat conversation
  The user's visible chat thread in ChatGPT Web. DevSpace may not receive a stable native ChatGPT conversation id through MCP, so DevSpace must not depend on it.

Workspace Agent triggered conversation
  A published ChatGPT Workspace Agent run triggered through OpenAI's Workspace Agents API. This supports a caller-defined `conversation_key` for continuing the same agent conversation across trigger events.

DevSpace conversation binding
  DevSpace's own durable mapping between a user, a task, a workspace session, a context window, and optional external conversation keys.

DevSpace workspace session
  The local execution and memory boundary: user + localAgentId + root + worktree/branch + contextWindowId.
```

### 1.1 Default interactive path

For normal user-driven local work, the default path is:

```text
User opens a ChatGPT chat with the shared GPT
  -> ChatGPT calls DevSpace remote MCP tools
  -> DevSpace authenticates the user
  -> DevSpace creates or resumes a conversation binding
  -> DevSpace opens or resumes a workspace session
  -> DevSpace routes local tool calls to the correct local agent
```

This path is interactive and suitable for reading/modifying local files.

### 1.2 Optional backend-trigger path

For automation, DevSpace may also trigger a published ChatGPT Workspace Agent through OpenAI's Workspace Agents API:

```text
External event or DevSpace backend job
  -> POST /v1/workspace_agents/{id}/trigger
  -> input + conversation_key
  -> OpenAI durably queues the trigger event
```

Use this for:

```text
scheduled context review
GitHub webhook summaries
failed CI triage
nightly workspace memory refresh
background task kickoff
customer/team automation that does not need immediate API retrieval of the agent answer
```

Do not use this as the primary live local-file editing path because the official trigger endpoint currently returns `202 Accepted` without a public run id or retrievable response body.

### 1.3 Conversation binding rule

Every local workspace conversation should get a DevSpace-owned id:

```text
devspaceConversationId
```

It binds:

```text
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

The model should keep `workspaceSessionId` and `devspaceConversationId` in its visible context after `open_workspace`. The server must still validate ownership on every tool call.

### 1.4 How to separate web conversations

If the same user opens the same workspace in multiple ChatGPT chats, DevSpace should not silently merge all work.

Recommended behavior:

```text
open_workspace with no existing active binding:
  create a new workspace session and context window

open_workspace with same user + same localAgentId + same root + same taskGoal within a recent window:
  return existing session only if reusePolicy is `reuse` or user confirms

open_workspace with same root but different taskGoal:
  create a separate conversation binding and context window

resume_workspace_session:
  explicitly resumes an existing binding

list_workspace_sessions:
  lets ChatGPT show candidates when the user says "continue the previous task"
```

## 2. Product Boundary

### 2.1 What ChatGPT Web owns

```text
reasoning
conversation with the user
planning
code judgment
context summarization when requested by DevSpace
calling MCP tools
OAuth authorization UX initiated by ChatGPT when the MCP app requires auth
```

### 2.2 What DevSpace Cloud owns

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

### 2.3 What the local DevSpace Agent owns

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

### 2.4 What the identity provider owns

Use a standards-compliant identity provider for:

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

Recommended choices:

```text
fastest hosted path:
  Clerk, Auth0, WorkOS, Supabase Auth, or similar OIDC provider

self-hosted enterprise path:
  Keycloak or Zitadel

not recommended for v1:
  custom username/password database plus custom OAuth authorization server
```

DevSpace should avoid storing user passwords. If DevSpace later ships a native account system, it should still implement standard OIDC/OAuth behavior and password security at a mature identity-provider level. That is not the right first product slice.

### 2.5 Non-goals

Do not build this path:

```text
ChatGPT Web -> DevSpace -> Codex CLI / Claude Code CLI -> local project
```

Do not make these assumptions:

```text
all users share one bearer token
all users share one local agent
all users share one workspace database row
ChatGPT conversation identity alone is enough for routing
Workspace Agents conversation_key is enough for local workspace routing
local userId can be trusted from MCP request body
workspace path sent by the model is automatically safe
shell command text is safe because the model produced it
AGENTS.md or repository docs are trusted instructions without prompt-injection risk
```

## 3. Recommended Deployment Topology

### 3.1 Domains

Minimum viable production topology:

```text
https://mcp.devspace.example.com/mcp
https://mcp.devspace.example.com/.well-known/oauth-protected-resource
https://mcp.devspace.example.com/.well-known/oauth-authorization-server
https://mcp.devspace.example.com/agent/connect
https://mcp.devspace.example.com/api/*
```

A larger deployment can split domains:

```text
mcp.devspace.example.com      remote MCP endpoint for ChatGPT
relay.devspace.example.com    local agent WebSocket / relay traffic
app.devspace.example.com      user dashboard and local-agent management
auth.devspace.example.com     IdP domain or auth proxy when self-hosting
```

For the first implementation, one domain with path-based routing is enough.

### 3.2 Public MCP endpoint

ChatGPT connects to one remote MCP URL:

```text
https://mcp.devspace.example.com/mcp
```

The endpoint should be stateless at the HTTP process level. All tenant state should live in Postgres and the relay connection registry.

### 3.3 Production database decision

Production cloud relay should use Postgres.

Reasons:

```text
multi-user concurrency
transactional tenant isolation
row-level ownership filters
workspace/session/relay event indexing
high-volume runtime event writes
long-lived audit trail
background compaction jobs
future horizontal scaling
read replicas and backup tooling
JSONB for structured runtime payloads
migration path to row-level security if needed
```

SQLite remains useful only for:

```text
local development
unit tests
single-user local demo
embedded local-agent cache
offline local queue before reconnect
```

The code should introduce a database boundary early:

```text
src/db/types.ts
src/db/postgres.ts
src/db/sqlite-dev.ts
src/db/migrations/*
```

Do not let core runtime logic depend directly on `better-sqlite3` APIs.

### 3.4 OAuth / OIDC requirement

Use OAuth/OIDC for multi-user mode.

Official MCP/App behavior to align with:

```text
ChatGPT queries protected resource metadata.
ChatGPT performs authorization-code flow with PKCE when the user authorizes.
ChatGPT sends Authorization: Bearer <token> to the MCP server.
The MCP server validates issuer, audience/resource, expiration, scopes, and subject.
```

The MCP server must not accept `userId`, `tenantId`, or `accountId` from the tool input as the trusted caller identity.

Trusted identity source:

```text
OAuth access token claims
  iss       -> trusted issuer
  sub       -> external user subject
  aud       -> this MCP protected resource
  scope     -> allowed DevSpace capabilities
  org/team  -> optional tenant/org signal when the IdP supports it
```

DevSpace-owned mapping:

```text
external issuer + external subject -> devspace user_id
external org/team claim or selected workspace -> devspace tenant_id
```

### 3.5 Login UI

Do not put a raw username/password form inside the GPT or MCP tool UI.

Recommended UX:

```text
ChatGPT MCP auth:
  ChatGPT opens the provider-hosted OAuth authorization page.
  User signs in with the IdP.
  ChatGPT receives an access token for the MCP protected resource.
  DevSpace validates the token on every MCP request.

DevSpace web dashboard:
  Show Sign in / Connect account button.
  Redirect to the IdP hosted login or use the IdP's secure SDK.
  Do not store passwords in DevSpace.

Local DevSpace Agent:
  Use browser-based OAuth login with PKCE or device-code flow.
  After login, register the device/agent with DevSpace Cloud.
  Store only local device credentials and refresh material allowed by the IdP policy.
```

Avoid:

```text
custom password box in ChatGPT widgets
pasting API keys into the GPT conversation
one shared MCP secret for every user
manual userId entry
```

### 3.6 Cloud relay

The relay is the bridge between ChatGPT's remote MCP calls and a user's private local machine.

```text
ChatGPT Web
  -> HTTPS MCP request
  -> MCP Gateway authenticates user
  -> Gateway resolves devspaceConversationId/workspaceSessionId/localAgentId
  -> Cloud Relay sends request over user's existing local-agent connection
  -> Local Agent performs local operation
  -> Local Agent returns structured result
  -> MCP Gateway returns model-ready response to ChatGPT
```

The local agent should initiate an outbound connection to the relay:

```text
devspace-agent login
devspace-agent connect
```

Do not require users to expose localhost or open inbound firewall ports.

### 3.7 Secure tunnel option

For private/on-prem deployments, support an outbound-only secure tunnel mode. This maps to the same design principle as OpenAI Secure MCP Tunnel: local/private MCP remains private, while supported OpenAI surfaces reach it through an outbound tunnel client.

DevSpace should support both:

```text
cloud relay mode:
  DevSpace cloud receives MCP and routes to local agents

self-hosted tunnel mode:
  user/team runs MCP server privately and connects through an outbound tunnel
```

## 4. OpenAI Workspace Agents API Alignment

Workspace Agents API is useful, but it is not a replacement for DevSpace MCP relay.

### 4.1 Official behavior to absorb

OpenAI's Workspace Agents trigger API supports:

```text
POST https://api.chatgpt.com/v1/workspace_agents/{id}/trigger
```

Where:

```text
id:
  stable public API trigger identifier for the published API channel, in agtch_XXX form

input:
  required string passed to the agent as trigger input

conversation_key:
  optional caller-defined stable identifier for continuing the same agent conversation across multiple trigger events

Idempotency-Key header:
  optional retry key. Reusing the same key for the same trigger returns the original accepted outcome instead of enqueueing a duplicate event

response:
  202 Accepted with no response body

current limitation:
  no public run id is returned, and the agent response cannot currently be retrieved through the API
```

Authentication uses Workspace Agent access tokens:

```text
Authorization: Bearer $AGENT_ACCESS_TOKEN
```

Operational notes from the official auth page:

```text
workspace admin must enable Workspace agents and personal access tokens
user creates an access token in ChatGPT Admin > Access tokens
user selects the Workspace Agents scope
the token is scoped to Workspace Agents API operations only
```

### 4.2 What DevSpace should absorb

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

### 4.3 DevSpace conversation key design

DevSpace should define its own stable conversation key format for external triggers and internal bindings:

```text
devspace:v1:{tenantId}:{userId}:{localAgentId}:{workspaceFingerprint}:{taskKey}
```

Where:

```text
workspaceFingerprint:
  hash of canonical root + optional repo remote + branch/worktree identity

taskKey:
  user-provided task id, issue id, PR id, CI run id, or generated task slug
```

Never expose raw local paths inside public conversation keys.

### 4.4 Optional Workspace Agent channel table

```sql
workspace_agent_channels(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  owner_user_id uuid not null references users(id),
  openai_agent_channel_id text not null,
  display_name text not null,
  token_secret_ref text not null,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

workspace_agent_trigger_events(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  workspace_agent_channel_id uuid not null references workspace_agent_channels(id),
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

Store Workspace Agent access tokens in a secrets manager. Do not store plaintext tokens in Postgres.

### 4.5 Optional DevSpace API: trigger workspace agent

This is a DevSpace backend/admin API, not a primary MCP tool for local file mutation.

```ts
interface TriggerWorkspaceAgentRequest {
  workspaceAgentChannelId: string;
  devspaceConversationId?: string;
  conversationKey: string;
  input: string;
  idempotencyKey: string;
}

interface TriggerWorkspaceAgentResponse {
  status: "accepted";
  acceptedAt: string;
  devspaceTriggerEventId: string;
}
```

Rules:

```text
idempotencyKey is required
conversationKey is required
same idempotencyKey + same input returns the same accepted record
same idempotencyKey + different input returns IDEMPOTENCY_CONFLICT
trigger token is loaded from secrets manager
accepted trigger does not imply response retrieval
```

## 5. Multi-User Routing Model

### 5.1 Routing tuple

Every MCP request must resolve to this tuple:

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

### 5.2 Why conversation auto-detection is not enough

A shared GPT does not provide a reliable local project identity by itself. The model may be used in multiple chats, by multiple users, with multiple machines and workspaces.

Therefore routing should be explicit:

```text
1. ChatGPT calls list_local_agents if needed.
2. ChatGPT calls list_workspace_sessions or open_workspace.
3. DevSpace creates or returns devspaceConversationId, workspaceSessionId, and contextWindowId.
4. All later tools must pass workspaceSessionId or devspaceConversationId.
5. DevSpace validates ownership and resolves the local agent.
```

### 5.3 Adaptive allocation rules

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
  route to the agent bound to that session

if devspaceConversationId is supplied:
  resolve its current workspaceSessionId/contextWindowId

if workspaceSessionId or devspaceConversationId belongs to another user:
  return WORKSPACE_SESSION_NOT_FOUND or CONVERSATION_NOT_FOUND

if requested path is outside allowed roots:
  return PATH_NOT_ALLOWED
```

### 5.4 Session stickiness

`open_workspace` creates a sticky local session:

```text
workspaceSessionId -> tenantId, userId, devspaceConversationId, localAgentId, root, mode, branch/worktree, contextWindowId
```

Subsequent tools must use that session. The server should reject attempts to use a workspace session owned by another user.

### 5.5 Required session tools

```text
list_workspace_sessions
open_workspace
resume_workspace_session
close_workspace_session
get_workspace_context
record_context_note
```

`list_workspace_sessions` is essential for web multi-session recovery.

```ts
interface ListWorkspaceSessionsRequest {
  localAgentId?: string;
  rootHint?: string;
  status?: "active" | "archived" | "closed";
  limit?: number;
}

interface WorkspaceSessionSummary {
  devspaceConversationId: string;
  workspaceSessionId: string;
  localAgentId: string;
  rootDisplay: string;
  branch?: string;
  taskGoal?: string;
  latestSummary?: string;
  changedFilesCount: number;
  lastCheckStatus?: "passed" | "failed" | "unknown";
  lastUsedAt: string;
}
```

## 6. Trust And Isolation Rules

### 6.1 Identity trust boundary

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

### 6.2 Tenant isolation

All durable rows must include at least:

```text
tenant_id
user_id
```

All workspace rows must include:

```text
local_agent_id
workspace_session_id
root
allowed_root_id
```

All query paths must filter by `tenant_id` and `user_id` first.

### 6.3 Context isolation

Context memory must be scoped:

```text
userId
localAgentId
devspaceConversationId
workspaceId
workspaceSessionId
contextWindowId
```

Never use a global context memory shared by all users of the GPT.

### 6.4 Approval isolation

Approval cache must be scoped at least by:

```text
userId
localAgentId
workspaceSessionId
permissionProfile
approvalSubject
```

Approving a command or path for one user must never approve it for another user.

### 6.5 Token forwarding rule

Do not forward ChatGPT's OAuth bearer token to the local agent.

Instead:

```text
MCP Gateway verifies the user token.
MCP Gateway derives userId/tenantId/scopes.
MCP Gateway creates a scoped relay request.
Local agent receives only the relay request, operationId, workspaceSessionId, policy envelope, and deadline.
Local agent authenticates to relay with its own device credentials.
```

This prevents local machines from becoming holders of ChatGPT/MCP bearer tokens.

## 7. Production Data Model

Production storage target:

```text
Postgres
```

Development/test storage:

```text
SQLite-compatible adapter, only where explicitly marked dev/test
```

Implementation rule:

```text
Core stores use interfaces and migrations that map cleanly to Postgres.
Do not use SQLite-only behavior as a product contract.
Prefer timestamp with time zone in Postgres.
Prefer JSONB for payload/capabilities/structured fields.
Add composite indexes for tenant/user/conversation/session lookups.
```

### 7.1 Users, tenants, and identities

```sql
tenants(
  id uuid primary key,
  name text not null,
  plan text not null,
  status text not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
)

users(
  id uuid primary key,
  primary_tenant_id uuid not null references tenants(id),
  display_name text,
  email text,
  status text not null default 'active',
  created_at timestamptz not null,
  last_seen_at timestamptz not null
)

external_identities(
  id uuid primary key,
  user_id uuid not null references users(id),
  issuer text not null,
  subject text not null,
  email text,
  claims jsonb not null default '{}',
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  unique(issuer, subject)
)

tenant_memberships(
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  role text not null,
  status text not null default 'active',
  created_at timestamptz not null,
  primary key(tenant_id, user_id)
)
```

Personal accounts should still use a tenant row:

```text
one user -> one personal tenant by default
teams/orgs -> one tenant with multiple memberships
```

### 7.2 Conversation bindings

```sql
devspace_conversations(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  local_agent_id uuid,
  workspace_session_id uuid,
  context_window_id uuid,
  task_goal text,
  conversation_label text,
  workspace_fingerprint text,
  workspace_agent_conversation_key text,
  status text not null default 'active',
  created_at timestamptz not null,
  last_used_at timestamptz not null
)

create index devspace_conversations_owner_idx
  on devspace_conversations(tenant_id, user_id, last_used_at desc);

create index devspace_conversations_workspace_idx
  on devspace_conversations(tenant_id, user_id, workspace_fingerprint, status);
```

### 7.3 Local agents and roots

```sql
local_agents(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  display_name text not null,
  hostname text,
  platform text,
  version text,
  public_key text,
  status text not null,
  capabilities jsonb not null default '[]',
  registered_at timestamptz not null,
  last_seen_at timestamptz not null
)

local_agent_allowed_roots(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  local_agent_id uuid not null references local_agents(id),
  root_path text not null,
  root_label text,
  read_allowed boolean not null default true,
  write_allowed boolean not null default false,
  execute_allowed boolean not null default false,
  created_at timestamptz not null
)
```

### 7.4 Workspace sessions

```sql
workspace_sessions(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid references devspace_conversations(id),
  local_agent_id uuid not null references local_agents(id),
  root text not null,
  workspace_fingerprint text not null,
  status text not null default 'active',
  mode text not null default 'checkout',
  source_root text,
  base_ref text,
  base_sha text,
  managed boolean not null default false,
  current_context_window_id uuid,
  active_task_id uuid,
  created_at timestamptz not null,
  last_used_at timestamptz not null
)

create index workspace_sessions_owner_idx
  on workspace_sessions(tenant_id, user_id, last_used_at desc);

create index workspace_sessions_agent_idx
  on workspace_sessions(tenant_id, user_id, local_agent_id, status);
```

### 7.5 Context memory

```sql
context_windows(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid references devspace_conversations(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  status text not null,
  token_budget integer,
  estimated_tokens integer,
  summary_id uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
)

context_events(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid references devspace_conversations(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  context_window_id uuid not null references context_windows(id),
  event_type text not null,
  source text not null,
  payload jsonb not null,
  created_at timestamptz not null
)

context_summaries(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid references devspace_conversations(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  context_window_id uuid not null references context_windows(id),
  summary_type text not null,
  content text not null,
  structured_fields jsonb not null default '{}',
  source_event_start_id uuid,
  source_event_end_id uuid,
  validation_status text not null,
  created_at timestamptz not null
)
```

### 7.6 Runtime, approvals, and relay

```sql
runtime_events(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid,
  local_agent_id uuid,
  workspace_session_id uuid,
  request_id text not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null
)

tool_runs(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid,
  local_agent_id uuid not null references local_agents(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  tool_name text not null,
  operation_id text not null,
  status text not null,
  risk_level text not null,
  approval_id uuid,
  started_at timestamptz not null,
  finished_at timestamptz,
  input_fingerprint text not null,
  result_summary text,
  unique(tenant_id, user_id, operation_id)
)

approvals(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid,
  local_agent_id uuid not null references local_agents(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  subject_type text not null,
  subject_fingerprint text not null,
  status text not null,
  decision text,
  scope text not null,
  reason text,
  created_at timestamptz not null,
  resolved_at timestamptz
)

relay_requests(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  devspace_conversation_id uuid,
  local_agent_id uuid not null references local_agents(id),
  workspace_session_id uuid,
  operation_id text not null,
  method text not null,
  payload jsonb not null,
  status text not null,
  deadline_at timestamptz not null,
  created_at timestamptz not null,
  completed_at timestamptz
)
```

## 8. Auth Architecture

### 8.1 Recommended auth provider strategy

Use external OIDC provider for user auth.

Recommended v1:

```text
Hosted OIDC provider
  fastest product path
  less security surface
  handles password/passkey/MFA/reset
  integrates with OAuth metadata
```

Acceptable self-hosted enterprise path:

```text
Keycloak or Zitadel
  self-hosted identity provider
  still standards-based
  DevSpace still does not store passwords directly
```

Avoid for v1:

```text
custom users table + password hashes + custom OAuth server
```

### 8.2 ChatGPT MCP OAuth flow

```text
1. User invokes DevSpace MCP tool in ChatGPT.
2. ChatGPT queries DevSpace protected resource metadata.
3. ChatGPT starts authorization-code + PKCE flow.
4. User signs in on the IdP hosted login page.
5. IdP issues an access token intended for the DevSpace MCP protected resource.
6. ChatGPT calls the MCP server with Authorization: Bearer <token>.
7. DevSpace verifies token issuer, audience/resource, expiration, scopes, and subject.
8. DevSpace maps external identity to internal user/tenant.
9. DevSpace executes only authorized tools.
```

### 8.3 Local agent login flow

```text
1. User runs devspace-agent login.
2. Agent opens browser or shows device code.
3. User authenticates with the same IdP.
4. DevSpace Cloud creates a one-time device registration challenge.
5. Agent generates a local key pair.
6. Server stores agent public key and allowed root declarations.
7. Agent receives localAgentId and device credential.
8. Agent connects outbound to relay.
```

### 8.4 Token types

```text
user access token:
  issued by IdP
  accepted by MCP/API gateway
  not forwarded to local agents

workspace agent access token:
  provisioned from ChatGPT Admin access-token flow
  scoped only to Workspace Agents API operations
  stored in secrets manager if DevSpace supports automation triggers
  not used for local relay authorization

local agent device credential:
  minted after authenticated registration
  used only for /agent/connect
  can be rotated/revoked

relay request token/signature:
  short-lived internal envelope from cloud to local agent
  contains requestId, operationId, workspaceSessionId, deadline, policy summary
```

### 8.5 Scope model

Recommended OAuth scopes for DevSpace MCP:

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

## 9. API Contract: Remote MCP Tools

All tools below are called by ChatGPT through the shared remote MCP server.

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

### 9.1 Unified response envelope

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

### 9.2 Unified error model

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

### 9.3 Conversation tools

```text
list_workspace_sessions
open_workspace
resume_workspace_session
close_workspace_session
get_workspace_context
record_context_note
```

`open_workspace` request:

```ts
interface OpenWorkspaceRequest {
  devspaceConversationId?: string;
  localAgentId?: string;
  path: string;
  mode?: "checkout" | "worktree";
  baseRef?: string;
  taskGoal?: string;
  conversationLabel?: string;
  reusePolicy?: "create_new" | "reuse_if_exact" | "ask_if_ambiguous";
  operationId?: string;
}
```

`open_workspace` response:

```ts
interface OpenWorkspaceResponse {
  devspaceConversationId: string;
  workspaceSessionId: string;
  workspaceId: string;
  localAgentId: string;
  root: string;
  mode: "checkout" | "worktree";
  branch?: string;
  baseRef?: string;
  baseSha?: string;
  contextWindowId: string;
  availableAgentsFiles: Array<{ path: string }>;
  loadedAgentsFiles: Array<{ path: string; content: string }>;
  availableSkills: Array<{ name: string; description: string; path: string }>;
  context: {
    estimatedTokens: number;
    compactionRecommended: boolean;
    latestSummary?: string;
    pinnedFacts: string[];
  };
}
```

### 9.4 Local agent tools

```text
list_local_agents
get_local_agent_status
```

### 9.5 File, patch, command, git, and asset tools

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

Rules:

```text
read tools are path-validated
large files return bounded excerpts or chunk refs
patch is preferred for writes
commands are policy-gated and output-capped
all writes and command runs record context and runtime events
all risky actions require approval
```

## 10. Local Agent Relay Contract

### 10.1 Agent connection

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

### 10.2 Relay request envelope

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

### 10.3 Delivery semantics

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

A compacted summary must not lose:

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

### 12.1 Tool runtime bus

Absorb Codex `tools/orchestrator.rs` behavior:

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

No local capability should bypass this bus.

### 12.2 Approval store

Absorb Codex approval caching:

```text
approve once
approve for session
approve matching command prefix
approve matching path set
approve network host
reject and remember
```

Approval keys must include:

```text
userId + localAgentId + workspaceSessionId + permissionProfile + approvalSubjectFingerprint
```

### 12.3 Command policy engine

Absorb Codex `exec_policy.rs` concepts:

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

### 12.4 Patch-first editing

Absorb Codex `apply_patch`, `safety.rs`, and `apply-patch` crate behavior:

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

DevSpace should prefer:

```text
apply_patch > edit_file > write_file > shell writes
```

### 12.5 Turn diff tracker

Absorb Codex `turn_diff_tracker.rs` behavior:

```text
track exact patch deltas during a turn
render current diff without rereading everything
handle adds/deletes/updates/renames
cache rendered diffs
invalidate when exactness is lost
```

### 12.6 Bounded command execution

Absorb Codex `exec.rs` behavior:

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

### 12.7 Session and rollout archive

Absorb Codex rollout/session ideas:

```text
thread/session metadata
archived sessions
summary reads
session lookup
memory generation option
resume hints
```

DevSpace should support:

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

### 12.8 Config layers, hooks, and workflow packs

Absorb:

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

### 12.9 Multimodal local gateway beyond Codex

DevSpace can exceed Codex for ChatGPT Web by supporting:

```text
code + PDFs + images + screenshots + spreadsheets + Office docs + generated artifacts
```

Local deterministic asset tools:

```text
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

The UI is not the model. It is the local command center for:

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

### Phase 0: Consolidate planning

Exit criteria:

```text
single source-of-truth plan exists
multi-user relay architecture is defined
web multi-session model is defined
Workspace Agents API optional role is defined
production auth provider decision is defined
Postgres-first multi-user storage decision is defined
Codex absorption scope is defined
```

### Phase 1: Auth provider integration and protected MCP resource

Files likely:

```text
src/auth/*
src/server.ts
src/config.ts
src/db/*
src/errors/*
src/request-context/*
```

Work:

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

Exit criteria:

```text
unauthenticated MCP call is rejected
invalid issuer is rejected
invalid audience is rejected
missing scope is rejected
valid token maps to userId/tenantId
no tool trusts userId from body
production config requires Postgres
local dev can use SQLite adapter only in dev mode
```

### Phase 2: Local agent registration and relay

Work:

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

### Phase 3: Conversation binding and workspace routing

Work:

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

### Phase 4: Context ledger core

Work:

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

### Phase 5: Context compaction

Work:

```text
prepare_context_compaction
save_context_summary
required field validation
summary source range tracking
pinned fact preservation
compaction recommendation
```

### Phase 6: Runtime event store and UI protocol

Work:

```text
runtime_events table
appendRuntimeEvent
listRuntimeEvents
UI event envelope
WebSocket or SSE stream for local UI
MCP widget payload alignment
```

### Phase 7: Tool runtime bus

Work:

```text
wrap all tools in common lifecycle
classify risk
record operationId
record tool run
record context events
emit UI events
normalize errors
```

### Phase 8: Policy and approvals

Work:

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

### Phase 9: Patch-first editing

Work:

```text
apply_patch tool
patch parser/validator
path safety
approval integration
exact delta tracking
context events
show_changes integration
```

### Phase 10: Command execution profiles

Work:

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

### Phase 11: Diff and rollback

Work:

```text
per-task diff
since-open diff
file diff
rollback file
rollback patch operation
rollback managed worktree
mark reviewed
```

### Phase 12: Workspace Agents optional automation integration

Work:

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

### Phase 13: Multimodal local asset gateway

Work:

```text
inspect_asset
extract_text
render_asset_preview
compare_assets
index_workspace_assets
bounded extraction
source-labeled asset facts
```

### Phase 14: Graphical workbench

Work:

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

### Phase 15: Workflow packs and hooks

Work:

```text
hook lifecycle
workflow pack manifest
feature-dev pack
code-review pack
security-guidance pack
commit-workflow pack
hierarchical AGENTS.md loading
```

### Phase 16: Evaluation and hardening

Work:

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

Do not start with the graphical UI first. The UI should render runtime events; it should not invent state by scraping logs.

## 17. End-To-End User Flows

### 17.1 First user setup

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

### 17.2 Normal coding task

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

### 17.3 Resume next day

```text
1. User says: continue yesterday's DevSpace MCP refactor.
2. ChatGPT calls list_workspace_sessions.
3. DevSpace returns candidate devspaceConversationId/workspaceSessionId rows.
4. ChatGPT asks user to pick if ambiguous.
5. ChatGPT calls resume_workspace_session.
6. DevSpace returns goal, summary, decisions, touched files, last tests, risks, next steps.
7. ChatGPT continues without rereading the whole repo.
```

### 17.4 Multiple web chats same workspace

```text
1. User opens Chat A for feature work.
2. open_workspace creates conversation A and context window A.
3. User opens Chat B for code review on same root.
4. open_workspace with different taskGoal creates conversation B and context window B.
5. Both share same local agent/root but maintain separate task memory and approvals unless explicitly scoped wider.
```

### 17.5 Workspace Agent backend trigger

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
src/server.ts
  Streamable HTTP MCP server, OAuth-protected endpoint, tool registration, widgets, server instructions

src/pi-tools.ts
  wraps @earendil-works/pi-coding-agent tools for read/write/edit/grep/find/ls/bash

src/roots.ts
  allowed root containment

src/workspaces.ts
  checkout/worktree sessions, workspace IDs, AGENTS/CLAUDE.md discovery, skills, path resolution

src/git-worktrees.ts
  isolated managed git worktrees

src/review-checkpoints.ts
  git snapshot review and show_changes

src/workspace-store.ts
  SQLite workspace sessions

src/db/client.ts and src/db/schema.ts
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
