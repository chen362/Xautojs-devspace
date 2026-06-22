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
But user identity, workspace sessions, context memory, approvals, file permissions, local agents, and audit trails must be isolated per user and per workspace.
```

Hard product decisions:

```text
Production mode is always multi-user capable.
Production cloud relay uses Postgres as the system database.
SQLite is allowed only for local development, test fixtures, or single-machine demo mode.
DevSpace should not self-build username/password login as the primary identity system.
DevSpace should use a standards-compliant OIDC/OAuth provider for user authentication.
DevSpace itself acts as the MCP protected resource, resource server, tenant mapper, policy engine, and relay gateway.
```

The target is not to call Codex CLI or Claude Code CLI as another agent. The target is to absorb the best local-agent runtime capabilities from Codex, implement them inside DevSpace, and then exceed Codex for web-driven multi-user local workspaces.

## 1. Product Boundary

### 1.1 What ChatGPT Web owns

```text
reasoning
conversation with the user
planning
code judgment
context summarization when requested by DevSpace
calling MCP tools
OAuth authorization UX initiated by ChatGPT when the MCP app requires auth
```

### 1.2 What DevSpace Cloud owns

```text
remote MCP server
OAuth protected resource metadata
OAuth token verification
multi-tenant user and organization mapping
cloud relay to local agents
workspace routing
context memory ledger
context compaction store
approval and policy engine
runtime event log
UI/API gateway for dashboard and widgets
Postgres production storage
```

### 1.3 What the local DevSpace Agent owns

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

### 1.4 What the identity provider owns

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

### 1.5 Non-goals

Do not build this path:

```text
ChatGPT Web -> DevSpace -> Codex CLI / Claude Code CLI -> local project
```

That would create a second agent runtime and can consume Codex/Claude-side usage. The useful parts to absorb are Codex's local context architecture, compaction model, runtime policy, patch discipline, review ergonomics, and session/event model.

Do not make these assumptions:

```text
all users share one bearer token
all users share one local agent
all users share one workspace database row
ChatGPT conversation identity alone is enough for routing
local userId can be trusted from MCP request body
workspace path sent by the model is automatically safe
shell command text is safe because the model produced it
AGENTS.md or repository docs are trusted instructions without prompt-injection risk
```

## 2. Recommended Deployment Topology

### 2.1 Domains

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

### 2.2 Public MCP endpoint

ChatGPT connects to one remote MCP URL:

```text
https://mcp.devspace.example.com/mcp
```

The endpoint must support remote MCP transport supported by ChatGPT Apps, currently Streamable HTTP/SSE-style remote MCP behavior depending on the configured host surface.

The endpoint should be stateless at the HTTP process level. All tenant state should live in Postgres and the relay connection registry.

### 2.3 Production database decision

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

### 2.4 OAuth / OIDC requirement

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

### 2.5 Which login UI to build

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

Acceptable UI labels:

```text
Sign in with DevSpace
Connect ChatGPT
Connect this computer
Register local agent
Choose workspace
```

Avoid:

```text
custom password box in ChatGPT widgets
pasting API keys into the GPT conversation
one shared MCP secret for every user
manual userId entry
```

### 2.6 OAuth client model

There are three different client surfaces:

```text
ChatGPT MCP client:
  ChatGPT acts as the OAuth client for the remote MCP app.
  It uses authorization-code + PKCE according to the MCP app auth flow.

DevSpace web dashboard client:
  Browser app or backend-for-frontend authenticates with the same IdP.

Local DevSpace Agent client:
  Native/CLI app uses device-code flow or loopback/browser PKCE.
```

DevSpace Cloud should expose protected resource metadata for the MCP server and verify tokens minted for that protected resource. If using an IdP that supports Client ID Metadata Documents or dynamic client registration, align with ChatGPT MCP auth expectations.

### 2.7 Cloud relay

The relay is the bridge between ChatGPT's remote MCP calls and a user's private local machine.

```text
ChatGPT Web
  -> HTTPS MCP request
  -> MCP Gateway authenticates user
  -> Gateway resolves workspaceSessionId/localAgentId
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

### 2.8 Secure tunnel option

For private/on-prem deployments, support an outbound-only secure tunnel mode. This maps to the same design principle as OpenAI Secure MCP Tunnel: local/private MCP remains private, while supported OpenAI surfaces reach it through an outbound tunnel client.

DevSpace should support both:

```text
cloud relay mode:
  DevSpace cloud receives MCP and routes to local agents

self-hosted tunnel mode:
  user/team runs MCP server privately and connects through an outbound tunnel
```

## 3. Multi-User Routing Model

### 3.1 Routing key

Every MCP request must resolve to this routing tuple:

```text
tenantId
userId
localAgentId
workspaceId
workspaceSessionId
contextWindowId
requestId
```

Minimum key for safe routing:

```text
userId + localAgentId + workspaceSessionId
```

### 3.2 Why conversation auto-detection is not enough

A shared GPT does not provide a reliable local project identity by itself. The model may be used in multiple chats, by multiple users, with multiple machines and workspaces.

Therefore routing should be explicit:

```text
1. ChatGPT calls list_local_agents if needed.
2. ChatGPT calls open_workspace.
3. DevSpace returns workspaceSessionId and contextWindowId.
4. All later tools must pass workspaceSessionId.
```

If the user has exactly one online agent and one default workspace, DevSpace may choose it automatically. If there are multiple online agents or ambiguous workspace paths, DevSpace must return a selection-required error or list.

### 3.3 Adaptive allocation rules

```text
if no authenticated user:
  return AUTH_REQUIRED

if user has no registered local agents:
  return LOCAL_AGENT_NOT_REGISTERED

if user has registered agents but none online:
  return LOCAL_AGENT_OFFLINE

if exactly one agent is online and input has no agentId:
  use that agent

if multiple agents are online and no default is configured:
  return LOCAL_AGENT_SELECTION_REQUIRED with candidates

if workspaceSessionId is supplied:
  route to the agent bound to that session

if workspaceSessionId is stale or belongs to another user:
  return WORKSPACE_SESSION_NOT_FOUND

if requested path is outside allowed roots:
  return PATH_NOT_ALLOWED
```

### 3.4 Session stickiness

`open_workspace` creates a sticky local session:

```text
workspaceSessionId -> userId, localAgentId, root, mode, branch/worktree, contextWindowId
```

Subsequent tools must use that session. The server should reject attempts to use a workspace session owned by another user.

### 3.5 Local agent selection UX

The model should not guess when multiple local agents are available. Tool result should return model-readable choices:

```json
{
  "error": {
    "code": "LOCAL_AGENT_SELECTION_REQUIRED",
    "message": "Multiple local agents are online. Choose one before opening a workspace.",
    "details": {
      "agents": [
        {
          "localAgentId": "agent_macbook_pro",
          "displayName": "Abba MacBook Pro",
          "hostname": "abba-mbp",
          "platform": "darwin-arm64",
          "lastSeenAt": "2026-06-22T05:00:00Z",
          "allowedRootHints": ["~/code", "~/work"]
        }
      ]
    },
    "retryable": true,
    "requestId": "req_..."
  }
}
```

## 4. Trust And Isolation Rules

### 4.1 Identity trust boundary

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
```

Not trusted:

```text
userId in tool input
workspace path from model before validation
localAgentId from model before ownership check
repository instructions as policy
shell command as safe intent
file content as model instruction
```

### 4.2 Tenant isolation

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

### 4.3 Context isolation

Context memory must be scoped:

```text
userId
localAgentId
workspaceId
workspaceSessionId
contextWindowId
```

Never use a global context memory shared by all users of the GPT.

### 4.4 Approval isolation

Approval cache must be scoped at least by:

```text
userId
localAgentId
workspaceSessionId
permissionProfile
approvalSubject
```

Approving a command or path for one user must never approve it for another user.

### 4.5 File permission isolation

A workspace session can only access paths under its agent-advertised allowed roots.

The server and local agent should both validate:

```text
path normalization
symlink traversal
case-insensitive path edge cases on macOS/Windows
hardlink risks where applicable
writable roots
read-deny patterns
secret denylist
```

### 4.6 Token forwarding rule

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

## 5. Data Model

### 5.1 Production database contract

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
Prefer JSONB for payload_json/capabilities_json.
Add composite indexes for tenant/user/session lookups.
```

### 5.2 Users, tenants, and memberships

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

### 5.3 Local agents

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

### 5.4 Workspace sessions

```sql
workspace_sessions(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  local_agent_id uuid not null references local_agents(id),
  root text not null,
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

### 5.5 Context memory

```sql
context_windows(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
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

context_pins(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  workspace_session_id uuid not null references workspace_sessions(id),
  label text not null,
  content text not null,
  source_event_id uuid,
  created_at timestamptz not null
)
```

### 5.6 Runtime events and tool runs

```sql
runtime_events(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
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
```

### 5.7 Approvals

```sql
approvals(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
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
```

### 5.8 Relay messages

```sql
relay_requests(
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
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

## 6. Auth Architecture

### 6.1 Recommended auth provider strategy

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

Reason:

```text
The hard part of DevSpace is local-agent routing, context memory, policy, patching, and relay safety.
Building a secure identity provider is a separate hard product.
```

### 6.2 ChatGPT MCP OAuth flow

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

### 6.3 Local agent login flow

Recommended local agent UX:

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

The local agent should not ask for the user's raw password.

### 6.4 Dashboard login flow

```text
1. User visits app.devspace.example.com.
2. UI shows Sign in / Connect account.
3. User is redirected to IdP login.
4. Dashboard receives authenticated session.
5. Dashboard shows local agents, workspaces, approvals, context, and settings.
```

### 6.5 Token types

```text
user access token:
  issued by IdP
  accepted by MCP/API gateway
  not forwarded to local agents

local agent device credential:
  minted after authenticated registration
  used only for /agent/connect
  can be rotated/revoked

relay request token/signature:
  short-lived internal envelope from cloud to local agent
  contains requestId, operationId, workspaceSessionId, deadline, policy summary

one-time registration code:
  short-lived
  used to bind a new local agent to a user
```

### 6.6 Account and tenant model

```text
Every user belongs to at least one tenant.
A personal user gets a personal tenant automatically.
Team/org mode adds tenant memberships.
All workspaces, agents, context, approvals, and events belong to a tenant and user.
```

### 6.7 Scope model

Recommended OAuth scopes:

```text
devspace:agents:read
devspace:workspace:open
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

Default user install should start with conservative scopes. Higher-risk scopes can be requested only when needed.

## 7. API Contract: Remote MCP Tools

All tools below are called by ChatGPT through the shared remote MCP server.

Common rules:

```text
Authentication:
  required OAuth bearer token in multi-user mode

Identity:
  derived from token, never from body

Idempotency:
  mutation tools require operationId or derive one from MCP tool call id + input fingerprint

Workspace:
  all workspace tools require workspaceSessionId after open_workspace

Errors:
  use stable machine-readable error codes
```

### 7.1 Unified tool response envelope

Internally every tool should produce:

```ts
interface ToolResponse<T = unknown> {
  result: string;
  data?: T;
  meta: {
    requestId: string;
    workspaceSessionId?: string;
    contextWindowId?: string;
    operationId?: string;
    estimatedTokens?: number;
    eventsRecorded?: number;
    compactionRecommended?: boolean;
  };
}
```

### 7.2 Unified error model

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
IDEMPOTENCY_CONFLICT
INTERNAL_ERROR
```

### 7.3 `list_local_agents`

Purpose:

```text
Return local agents owned by the authenticated user.
```

Request:

```ts
interface ListLocalAgentsRequest {
  includeOffline?: boolean;
  capability?: "files" | "git" | "shell" | "assets" | "ui";
}
```

Response:

```ts
interface ListLocalAgentsResponse {
  agents: Array<{
    localAgentId: string;
    displayName: string;
    hostname?: string;
    platform?: string;
    version?: string;
    status: "online" | "offline" | "degraded";
    lastSeenAt: string;
    capabilities: string[];
    allowedRootHints: string[];
  }>;
}
```

### 7.4 `open_workspace`

Purpose:

```text
Bind this conversation/task to a local agent and workspace root.
```

Request:

```ts
interface OpenWorkspaceRequest {
  localAgentId?: string;
  path: string;
  mode?: "checkout" | "worktree";
  baseRef?: string;
  taskGoal?: string;
  operationId?: string;
}
```

Validation:

```text
path is required
path must resolve under one allowed root
localAgentId must belong to authenticated user
mode defaults to checkout
worktree mode requires git eligibility
operationId is recommended for retry safety
```

Response:

```ts
interface OpenWorkspaceResponse {
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

Idempotency:

```text
Same user + localAgentId + canonical path + mode + operationId returns same workspaceSessionId when still active.
Different canonical path under same operationId returns IDEMPOTENCY_CONFLICT.
```

### 7.5 `get_workspace_context`

Purpose:

```text
Return compact, source-labeled, model-ready local project context.
```

Request:

```ts
interface GetWorkspaceContextRequest {
  workspaceSessionId: string;
  mode?: "brief" | "coding" | "review" | "resume" | "asset";
  tokenBudget?: number;
  includePins?: boolean;
  includeRecentEvents?: boolean;
}
```

Response includes:

```text
goal
current task summary
latest compacted summary
pinned facts
decisions
assumptions
open questions
touched files
changed files
last test/build results
open risks
next steps
source labels
context budget status
```

### 7.6 `prepare_context_compaction`

Purpose:

```text
Ask DevSpace to prepare a compaction packet for ChatGPT Web to summarize.
```

Required summary fields:

```text
goal
current state
important decisions
assumptions
files read
files changed
tests/build results
open risks
next steps
what not to forget
```

### 7.7 `save_context_summary`

Purpose:

```text
Persist a ChatGPT-produced summary back into DevSpace context memory.
```

Validation:

```text
compactionRequestId must exist and belong to same user/session
summary must include all required fields
filesChanged cannot omit known changed files unless explicitly marked irrelevant
nextSteps cannot be empty when task remains open
```

### 7.8 File tools

```text
read_file
list_directory
search_workspace
find_files
```

Rules:

```text
read tools are read-only but still path-validated
large files return bounded excerpts or chunk references
binary files return metadata and suggest inspect_asset
all reads record context events
```

### 7.9 `apply_patch`

Purpose:

```text
Patch-first workspace editing. This should become the preferred write path.
```

Runtime:

```text
parse patch
validate paths
classify changes
check writable roots
check sensitive path denylist
preview diff
request approval if policy requires
apply patch locally
record exact delta
update diff tracker
record context event
emit UI event
```

### 7.10 Command tools

Recommended split:

```text
run_check       tests/build/lint/typecheck, approval-light
run_command     policy-gated command with explicit purpose
run_shell       advanced escape hatch, strict/off by default
start_server    long-running dev server process
stop_server     stop managed process
```

Rules:

```text
command is array form where possible
cwd must be inside workspace
output is capped
stdout/stderr deltas are streamed to UI
final result is summarized for model
network commands require approval
write/destructive commands require approval or are forbidden
```

### 7.11 Git and review tools

```text
git_status
git_diff
git_log
show_changes
list_changed_files
show_file_diff
rollback_changes
mark_reviewed
```

Rules:

```text
show_changes is safe/read-only
rollback requires approval
rollback can target file, patch operation, session, or managed worktree
all diff/rollback events become context memory
```

### 7.12 Asset tools

```text
inspect_asset
extract_text
render_asset_preview
compare_assets
index_workspace_assets
```

Rules:

```text
asset path must be allowed
binary contents are not dumped to the model
extractors return bounded source-labeled facts
OCR or document conversion warnings must be visible
large extracted text uses chunks and summaries
```

## 8. Local Agent Relay Contract

### 8.1 Agent registration

The local agent must be registered to a user account.

```text
User signs in through browser or device-code flow.
Server issues local-agent registration challenge.
Local agent generates or loads device key.
Server binds localAgentId to userId and tenantId.
```

### 8.2 Agent connection

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

### 8.3 Relay request envelope

```ts
interface RelayRequest {
  type: "relay.request";
  requestId: string;
  operationId: string;
  tenantId: string;
  userId: string;
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

### 8.4 Relay response envelope

```ts
interface RelayResponse {
  type: "relay.response";
  requestId: string;
  operationId: string;
  status: "ok" | "error";
  result?: unknown;
  error?: DevSpaceError["error"];
  events?: RuntimeEvent[];
}
```

### 8.5 Delivery semantics

```text
Relay delivery is at-least-once under reconnect/timeouts.
Local agent must dedupe by operationId + input fingerprint for mutations.
Read tools may be retried freely.
Write tools must be idempotent or return conflict.
Long-running commands must expose status and cancellation.
```

## 9. Context Memory And Compaction Design

This remains the highest-value capability to absorb from Codex.

### 9.1 Codex behavior to absorb

Codex has:

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
context windows
pinned facts
compaction requests
summary validation
resume summaries
project/task memory
```

### 9.2 Context event types

Required event types:

```text
workspace_opened
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
```

### 9.3 Context facets

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

### 9.4 Projection modes

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
  asset summaries, extracted text, relevant files, user notes
```

### 9.5 Compaction invariants

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
```

### 9.6 What DevSpace cannot do

DevSpace cannot rewrite ChatGPT Web's native conversation history. It can only maintain local project/session context and expose compact model-ready projections through MCP tools, server instructions, and widgets.

Therefore:

```text
ChatGPT Web summarizes.
DevSpace validates and stores.
Future ChatGPT turns retrieve context through get_workspace_context.
```

## 10. Codex Deep Capability Absorption

### 10.1 Tool runtime bus

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

DevSpace implementation:

```ts
interface ToolRuntimeBus {
  run<TInput, TOutput>(input: {
    workspaceSessionId: string;
    toolName: string;
    operationId: string;
    params: TInput;
    risk: RuntimeRisk;
  }): Promise<RuntimeResult<TOutput>>;
}
```

No local capability should bypass this bus.

### 10.2 Approval store

Absorb Codex approval caching:

```text
approve once
approve for session
approve matching command prefix
approve matching path set
approve network host
reject and remember
```

Approval keys must include user/session scope:

```text
userId + localAgentId + workspaceSessionId + permissionProfile + approvalSubjectFingerprint
```

### 10.3 Command policy engine

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

DevSpace command classes:

```text
read_only
check
build
network
write
destructive
forbidden_by_default
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

### 10.4 Patch-first editing

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

Shell redirection, heredocs, `sed -i`, ad-hoc Python/Node file writers should be discouraged or blocked for normal edits.

### 10.5 Turn diff tracker

Absorb Codex `turn_diff_tracker.rs` behavior:

```text
track exact patch deltas during a turn
render current diff without rereading everything
handle adds/deletes/updates/renames
cache rendered diffs
invalidate when exactness is lost
```

DevSpace should maintain:

```text
per-tool diff
per-task diff
since-workspace-open diff
since-last-review diff
rollback checkpoint diff
```

### 10.6 Bounded command execution

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

### 10.7 Session and rollout archive

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
resume by workspace session
resume by branch
resume by task goal
resume by changed files
resume by failed check
resume by pending approval
```

### 10.8 Context update diffing

Absorb Codex context updates:

```text
only send changed model-visible context when possible
version context projections
avoid replaying unchanged instructions unnecessarily
separate environment, permissions, instructions, token budget, and internal context fragments
```

### 10.9 Config layers and trust

Absorb Codex config-layer thinking:

```text
user config
team config
project config
trusted vs untrusted project rules
permission profile constraints
warnings when policy files fail to parse
```

DevSpace config precedence:

```text
server defaults
team policy
user policy
local agent policy
workspace policy
project instructions
runtime override
```

Project instructions can guide behavior but must not override safety policy.

### 10.10 Hooks and workflow packs

Absorb public Claude Code plugin workflow ideas and Codex hook lifecycle:

```text
SessionStart
PreToolUse
PostToolUse
PermissionRequest
PreCompact
PostCompact
Stop
SessionEnd
```

Workflow packs:

```text
feature-dev
code-review
security-guidance
commit-workflow
api-contract-first
minimal-patch-first
```

Hooks must be deterministic by default. LLM-backed hooks should be opt-in.

### 10.11 TUI/app-server UI ideas

Absorb Codex TUI/app-server product ideas:

```text
live task thread
active tool group
approval overlays
diff viewer
token/context usage status
MCP server status
skills/plugins list
thread/session state
queued message editing concept
resume picker
runtime metrics
```

DevSpace should implement a graphical workbench around the same event source used by MCP.

### 10.12 Multimodal local gateway beyond Codex

This is where DevSpace can exceed Codex for ChatGPT Web:

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

## 11. UI / Workbench Design Integrated Into Main Plan

### 11.1 UI role

The UI is not the model. It is the local command center for:

```text
connection status
workspace state
context memory
approvals
tool runs
diffs
rollback
asset previews
settings
```

### 11.2 Default layout

```text
+--------------------------------------------------------------------------------+
| Top Bar: Workspace / Branch / MCP Status / Context Budget / Safety Mode         |
+-------------+----------------------------+-------------------------------+-----+
| Left Rail   | Session + Task Sidebar     | Main Task Thread              |Right|
| - Workspace | - Active task              | - ChatGPT actions             |Pane |
| - Context   | - Recent sessions          | - Tool cards                  |     |
| - Changes   | - Pending approvals        | - Output streams              |     |
| - Runs      | - Failed checks            | - Assistant notes             |     |
| - Assets    | - Pinned memories          | - User interventions          |     |
| - Settings  |                            |                               |     |
+-------------+----------------------------+-------------------------------+-----+
| Composer / Command Bar / Attachments / Mode Switch / Send                       |
+--------------------------------------------------------------------------------+
```

### 11.3 Required panels

```text
Workspace panel
Context memory panel
Change review panel
Approval queue panel
Run output panel
Asset preview panel
Settings panel
```

### 11.4 Event card types

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

## 12. Security Model

### 12.1 Main risks

```text
cross-user data leak
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
accidental forwarding of user OAuth token to local agent
SQLite single-file assumptions leaking into production multi-user design
```

### 12.2 Required mitigations

```text
OAuth token validation on every MCP request
issuer validation
audience/resource validation
scope validation
per-user local agent ownership checks
workspaceSessionId ownership checks
allowed root validation in cloud and local agent
path normalization before access
sensitive path denylist
patch safety before writes
command policy before execution
approval isolation per user/session
operationId dedupe for mutations
short-lived relay request deadlines
agent heartbeat and version checks
audit log for all writes/commands/approvals
context summary validation
output caps and file-size caps
Postgres production storage with tenant/user indexes
no forwarding user bearer token to local agent
```

## 13. Implementation Roadmap

### Phase 0: Consolidate planning

Exit criteria:

```text
single source-of-truth plan exists
multi-user relay architecture is defined
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

Files likely:

```text
src/relay/*
src/agent/*
src/db/schema.ts
```

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

Exit criteria:

```text
user can register local agent
server sees online/offline status
server can relay a ping to the correct agent
requests cannot route to another user's agent
```

### Phase 3: Workspace routing

Files likely:

```text
src/workspaces.ts
src/workspace-store.ts
src/relay/workspace-router.ts
src/server.ts
```

Work:

```text
open_workspace with localAgentId
canonical path validation
allowed root binding
workspaceSessionId generation
contextWindowId generation
sticky routing
multi-agent selection errors
```

Exit criteria:

```text
open_workspace returns stable session
ambiguous agent selection returns candidates
offline agent returns LOCAL_AGENT_OFFLINE
all later tools require workspaceSessionId
```

### Phase 4: Context ledger core

Files likely:

```text
src/context/events.ts
src/context/store.ts
src/context/projection.ts
src/db/schema.ts
src/server.ts
```

Work:

```text
context_windows
context_events
context_pins
record_context_note
get_workspace_context
projection modes
source-labeled output
```

Exit criteria:

```text
workspace actions record context events
resume mode returns useful project/task summary
context is isolated per user/session
```

### Phase 5: Context compaction

Files likely:

```text
src/context/compaction.ts
src/context/summary-validation.ts
src/server.ts
```

Work:

```text
prepare_context_compaction
save_context_summary
required field validation
summary source range tracking
pinned fact preservation
compaction recommendation
```

Exit criteria:

```text
ChatGPT can compact local context through MCP
summary cannot omit changed files silently
future turn can resume from summary
```

### Phase 6: Runtime event store and UI protocol

Files likely:

```text
src/runtime/events.ts
src/runtime/event-store.ts
src/ui/events.ts
src/server.ts
```

Work:

```text
runtime_events table
appendRuntimeEvent
listRuntimeEvents
UI event envelope
WebSocket or SSE stream for local UI
MCP widget payload alignment
```

Exit criteria:

```text
tool runs emit structured events
UI can replay recent session state
MCP and UI share same event source
```

### Phase 7: Tool runtime bus

Files likely:

```text
src/runtime/tool-runtime-bus.ts
src/runtime/result.ts
src/policy/tool-policy.ts
src/server.ts
```

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

Exit criteria:

```text
read/search/write/shell/git tools all pass through runtime bus
no direct risky action bypasses policy hooks
```

### Phase 8: Policy and approvals

Files likely:

```text
src/policy/command-policy.ts
src/policy/path-policy.ts
src/policy/approval-store.ts
src/policy/rules.ts
src/server.ts
```

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

Exit criteria:

```text
dangerous commands blocked or require approval
network commands require approval
sensitive paths denied
approval cache scoped per user/session
```

### Phase 9: Patch-first editing

Files likely:

```text
src/patch/parser.ts
src/patch/apply-patch.ts
src/patch/safety.ts
src/patch/delta.ts
src/server.ts
```

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

Exit criteria:

```text
normal edits use apply_patch
patches outside workspace rejected
diff appears after patch
rollback metadata is available
```

### Phase 10: Command execution profiles

Files likely:

```text
src/commands/run-check.ts
src/commands/run-command.ts
src/commands/process-manager.ts
src/policy/command-policy.ts
```

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

Exit criteria:

```text
tests/builds can run safely
long output is capped and summarized
commands can be cancelled
policy decisions are visible
```

### Phase 11: Diff and rollback

Files likely:

```text
src/review-checkpoints.ts
src/diff/*
src/rollback/*
src/git.ts
```

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

Exit criteria:

```text
every write has reviewable diff
every patch has rollback point when possible
rollback records context event
```

### Phase 12: Multimodal local asset gateway

Files likely:

```text
src/assets/inspect.ts
src/assets/extract-text.ts
src/assets/preview.ts
src/assets/index.ts
src/server.ts
```

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

Exit criteria:

```text
images/PDFs/docs/spreadsheets can be inspected safely
model receives compact facts, not raw unbounded binary
asset facts can be pinned into context
```

### Phase 13: Graphical workbench

Files likely:

```text
src/ui/*
widgets/*
app/*
```

Work:

```text
workbench shell
task thread
context panel
diff panel
approval queue
run output panel
asset preview panel
settings panel
```

Exit criteria:

```text
user can see what ChatGPT is doing locally
user can approve/deny risky actions
user can inspect memory/diff/runs/assets
```

### Phase 14: Workflow packs and hooks

Files likely:

```text
src/hooks/*
src/workflows/*
src/skills.ts
src/workspaces.ts
```

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

Exit criteria:

```text
project instructions are loaded by hierarchy
workflow packs are discoverable
hooks can warn/block/record around tools
```

### Phase 15: Evaluation and hardening

Files likely:

```text
test/evals/*
test/fixtures/*
docs/security.md
```

Work:

```text
replayable local-agent scenarios
multi-user isolation tests
context resume tests
patch safety tests
command policy tests
asset extraction tests
relay timeout tests
```

Exit criteria:

```text
regression suite proves isolation, memory, safety, patching, and resume behavior
```

## 14. Recommended PR Sequence

```text
PR 1: auth provider integration + protected MCP resource + Postgres boundary
PR 2: local agent registration + outbound relay ping
PR 3: open_workspace routing through relay
PR 4: context ledger core + get_workspace_context
PR 5: context compaction tools + summary validation
PR 6: runtime event store + UI event protocol
PR 7: tool runtime bus wrapping existing tools
PR 8: policy engine + approval store
PR 9: apply_patch tool + patch safety
PR 10: run_check/run_command with caps/cancel
PR 11: diff/rollback expansion
PR 12: multimodal asset tools
PR 13: graphical workbench MVP
PR 14: hooks/workflow packs
PR 15: eval suite and hardening
```

Do not start with the graphical UI first. The UI should render runtime events; it should not invent state by scraping logs.

## 15. End-To-End User Flows

### 15.1 First user setup

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
10. DevSpace returns workspaceSessionId/contextWindowId.
11. User starts local coding task.
```

### 15.2 Normal coding task

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

### 15.3 Resume next day

```text
1. User says: continue yesterday's DevSpace MCP refactor.
2. ChatGPT calls list workspace sessions or get_workspace_context with resume mode.
3. DevSpace returns goal, summary, decisions, touched files, last tests, risks, next steps.
4. ChatGPT continues without rereading the whole repo.
```

### 15.4 Multi-agent ambiguity

```text
1. User has laptop and desktop agents online.
2. ChatGPT calls open_workspace without localAgentId.
3. DevSpace returns LOCAL_AGENT_SELECTION_REQUIRED.
4. ChatGPT asks user which machine.
5. User chooses.
6. open_workspace succeeds.
```

### 15.5 Risky command approval

```text
1. ChatGPT calls run_command for network install or destructive command.
2. Policy engine classifies risk.
3. Approval request is created.
4. UI and MCP result show approval required.
5. User approves once/session or denies.
6. Decision is scoped to user/session and recorded.
```

## 16. Acceptance Criteria

The system is successful when:

```text
same GPT can serve multiple users safely
one MCP domain can route to many local agents
production cloud mode uses Postgres
SQLite is limited to dev/test/local demo mode
user auth uses OIDC/OAuth provider instead of custom password storage
user A can never access user B's files, context, approvals, or local agents
ChatGPT can open a local workspace through MCP
ChatGPT can retrieve compact workspace context
ChatGPT can patch local files without invoking Codex CLI
ChatGPT can run tests/checks with output caps and cancellation
user can review diffs and rollback changes
context survives across turns and future sessions
compaction preserves important state
multimodal assets can be inspected locally and summarized safely
local UI shows memory, runs, approvals, diffs, and assets
all risky actions are auditable
```

A concrete target prompt should work:

```text
Open ~/code/my-api on my MacBook, remember the goal, read AGENTS.md,
inspect the error handling path, make the smallest patch, run tests,
show me the diff, and keep enough context so we can continue tomorrow.
```

Expected tool path:

```text
list_local_agents
open_workspace
get_workspace_context
read_file / search_workspace
apply_patch
run_check
show_changes
prepare_context_compaction
save_context_summary
```

## 17. Current DevSpace Baseline

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

DevSpace already has a strong MCP shell. The missing layers are:

```text
OIDC/OAuth provider integration
Postgres production storage
multi-user cloud relay
per-user local agent routing
context ledger
compaction
runtime event store
tool runtime bus
policy/approval engine
patch-first edit engine
bounded command runtime
multimodal asset gateway
local workbench UI
```

## 18. Source Notes

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

OpenAI public docs consulted for remote MCP/OAuth/tunnel direction:

```text
https://developers.openai.com/api/docs/mcp
https://developers.openai.com/apps-sdk/build/auth
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
```
