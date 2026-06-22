# DevSpace Automation Ingress Plan

Last updated: 2026-06-22

## 0. Executive Decision

DevSpace should add a first-class automation ingress layer before revisiting any
Codex Responses API compatibility work.

The product direction is:

```text
Strengthen the native DevSpace MCP / local workspace / Postgres path first.
Add event-driven automation entry points that can create auditable DevSpace work.
Keep Codex Responses proxying out of scope until the native path is stronger.
```

This plan covers three automation entry points:

```text
HTTP trigger:
  a backend, script, CI job, or internal tool asks DevSpace to start or record work

GitHub webhook:
  GitHub events create DevSpace automation events and future workspace tasks

runtime hook callback:
  DevSpace runtime events such as tool use, permission requests, and compaction
  can be observed or controlled through a typed internal hook protocol
```

This is intentionally similar in spirit to modern agent automation systems, but
it stays inside DevSpace's own trust, session, and workspace model.

## 1. Non-Goals

Do not implement these in this plan PR:

```text
No runtime endpoint code.
No database migrations.
No background worker.
No GitHub webhook receiver implementation.
No Workspace Agents trigger integration.
No Codex /v1/responses proxy.
No attempt to replace Codex's model/tool loop.
```

Future Workspace Agents integration remains optional and asynchronous. It must
not be used as a live replacement for MCP tools or local workspace execution
unless the upstream API later supports retrievable or streaming run output.

## 2. Core Architecture

The shared automation flow is:

```text
incoming event
  -> authenticate or verify signature
  -> validate size and schema
  -> derive source event identity
  -> apply idempotency check
  -> redact sensitive fields
  -> persist automation event
  -> create or link automation run
  -> optionally enqueue future work
  -> return stable acknowledgement
```

Initial service boundary:

```text
src/automation/types.ts
src/automation/ingress.ts
src/automation/redaction.ts
src/automation/idempotency.ts
src/automation/store.ts
src/automation/http-trigger.ts
src/automation/github-webhook.ts
src/automation/runtime-hooks.ts
```

The first implementation PRs should add contracts and storage before they run
any agentic work. Durable event capture is the foundation.

## 3. Identity And Trust

Trusted identity sources:

```text
HTTP trigger:
  source token or HMAC secret bound to automation_sources.id

GitHub webhook:
  raw-body HMAC signature using the source's configured webhook secret

runtime hook callback:
  internal relay credential or local agent device credential

Workspace/user mapping:
  server-side source configuration, not caller-supplied userId
```

Never trust these fields directly from a request body:

```text
userId
tenantId
workspaceSessionId
devspaceConversationId
localAgentId
conversationKey
repository path
branch name
shell command
```

Caller-provided identifiers are hints. DevSpace must resolve ownership and
routing from authenticated source configuration, tenant membership, and stored
workspace/session rows.

## 4. Endpoint Contracts

### 4.1 Generic HTTP Trigger

```text
POST /api/automation/triggers/{triggerId}/fire
```

Use this when a backend, CI job, scheduled script, or internal system wants to
start a DevSpace automation run.

Authentication:

```text
Authorization: Bearer <automation-source-token>
```

Idempotency:

```text
Idempotency-Key: <stable-key-for-this-source-event>
```

The idempotency key is required by default. A source may explicitly allow
unkeyed events for development, but production sources should reject unkeyed
requests with `IDEMPOTENCY_KEY_REQUIRED`.

Request body:

```ts
interface AutomationTriggerRequest {
  eventId?: string;
  text?: string;
  payload?: Record<string, unknown> | string;
  conversationKey?: string;
  workspaceHint?: {
    repository?: string;
    branch?: string;
    rootLabel?: string;
    workspaceSessionId?: string;
    devspaceConversationId?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
}
```

Validation rules:

```text
At least one of text or payload is required.
eventId, when present, must be stable for the source event.
conversationKey is caller-defined but not trusted for ownership.
workspaceHint is advisory and must be resolved server-side.
metadata values must be scalar and bounded.
request body size defaults to 256 KiB unless source config allows more.
```

Success response:

```ts
interface AutomationAcceptedResponse {
  automationRunId: string;
  automationEventId: string;
  status: "queued" | "accepted" | "duplicate";
  duplicate: boolean;
  dedupeGuaranteed: boolean;
  conversationKey?: string;
  createdAt: string;
}
```

Status codes:

```text
202 Accepted:
  new event accepted or duplicate resolved to the original run

400 Bad Request:
  invalid payload, missing text/payload, malformed eventId, oversized metadata

401 Unauthorized:
  missing or invalid source token

403 Forbidden:
  source token is valid but disabled or not allowed to fire this trigger

404 Not Found:
  triggerId is unknown or hidden from the caller

409 Conflict:
  same idempotency key was reused with a different request fingerprint

413 Payload Too Large:
  request exceeds configured source limit

429 Too Many Requests:
  source rate limit exceeded
```

### 4.2 GitHub Webhook Receiver

```text
POST /api/webhooks/github/{sourceId}
```

Use this when GitHub events should become DevSpace automation events.

Required headers:

```text
X-GitHub-Event
X-GitHub-Delivery
X-Hub-Signature-256
Content-Type: application/json
```

Signature rules:

```text
Verify the raw request body before JSON parsing.
Use constant-time comparison for signature checks.
Reject missing or invalid signatures.
Use X-GitHub-Delivery as the source event id.
```

Supported v1 events:

```text
pull_request.opened
pull_request.synchronize
pull_request.closed
pull_request.reopened
release.published
release.created
release.deleted
```

Success response:

```ts
interface GitHubWebhookAcceptedResponse {
  automationEventId: string;
  automationRunId?: string;
  status: "accepted" | "ignored" | "duplicate";
  duplicate: boolean;
  reason?: string;
}
```

Event mapping rules:

```text
Every valid GitHub delivery is stored once, even when ignored.
Ignored events still return 202 so GitHub does not retry intentionally ignored work.
Events beyond source filters should be status=ignored with a reason.
Duplicate X-GitHub-Delivery returns the original event/run identifiers.
```

### 4.3 Runtime Hook Callback

Runtime hooks are an internal DevSpace protocol. They are not a public webhook
surface in v1.

```text
POST /api/runtime/hooks
```

Authentication:

```text
Authorization: Bearer <local-agent-or-internal-relay-token>
```

Supported v1 hook events:

```text
PreToolUse
PostToolUse
PermissionRequest
PostCompact
```

Request body:

```ts
interface RuntimeHookRequest {
  hookEventName:
    | "PreToolUse"
    | "PostToolUse"
    | "PermissionRequest"
    | "PostCompact";
  operationId: string;
  requestId: string;
  tenantId?: string;
  userId?: string;
  localAgentId: string;
  workspaceSessionId?: string;
  devspaceConversationId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: Record<string, unknown>;
  permissionRequest?: {
    permissionId: string;
    action: string;
    subject: string;
    risk: "low" | "medium" | "high";
  };
  compact?: {
    reason: string;
    tokensBefore?: number;
    tokensAfter?: number;
    summaryId?: string;
  };
}
```

Hook response:

```ts
interface RuntimeHookResponse {
  continue: boolean;
  decision?: "allow" | "block" | "ask" | "deny";
  reason?: string;
  additionalContext?: string;
  systemMessage?: string;
  auditOnly?: boolean;
}
```

Decision rules:

```text
PreToolUse may block or ask before a tool runs.
PermissionRequest may allow, deny, or ask.
PostToolUse cannot undo the tool run; it can add context, audit, or request follow-up.
PostCompact cannot block completed compaction; it can audit and record quality signals.
Timeout defaults should fail open for audit hooks and fail closed only for configured policy hooks.
```

## 5. Error Model

All public automation APIs should use the same error envelope:

```ts
interface AutomationErrorResponse {
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
AUTOMATION_SOURCE_NOT_FOUND
AUTOMATION_SOURCE_DISABLED
AUTOMATION_TOKEN_INVALID
AUTOMATION_SIGNATURE_INVALID
AUTOMATION_EVENT_UNSUPPORTED
AUTOMATION_PAYLOAD_INVALID
AUTOMATION_PAYLOAD_TOO_LARGE
IDEMPOTENCY_KEY_REQUIRED
IDEMPOTENCY_CONFLICT
RATE_LIMITED
WORKSPACE_HINT_UNRESOLVED
WORKSPACE_SESSION_NOT_FOUND
CONVERSATION_NOT_FOUND
RUNTIME_HOOK_NOT_ALLOWED
INTERNAL_ERROR
```

## 6. Data Model

Production storage uses Postgres. SQLite may be used only for local development
or tests through the existing store abstraction.

### 6.1 automation_sources

```sql
create table automation_sources (
  id uuid primary key,
  tenant_id uuid not null,
  owner_user_id uuid,
  kind text not null,
  display_name text not null,
  status text not null,
  secret_ref text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Suggested `kind` values:

```text
http_trigger
github_webhook
runtime_hook
workspace_agent_bridge
```

Suggested indexes:

```sql
create index automation_sources_tenant_kind_idx
  on automation_sources (tenant_id, kind, status);
```

### 6.2 automation_events

```sql
create table automation_events (
  id uuid primary key,
  tenant_id uuid not null,
  source_id uuid not null references automation_sources(id),
  source_event_id text not null,
  event_type text not null,
  idempotency_key text,
  request_fingerprint text not null,
  conversation_key text,
  payload_redacted jsonb not null default '{}'::jsonb,
  payload_digest text not null,
  status text not null,
  received_at timestamptz not null default now(),
  accepted_at timestamptz,
  error_code text,
  error_message text
);
```

Required constraints:

```sql
create unique index automation_events_source_event_unique
  on automation_events (source_id, source_event_id);

create unique index automation_events_idempotency_unique
  on automation_events (source_id, idempotency_key)
  where idempotency_key is not null;

create index automation_events_tenant_received_idx
  on automation_events (tenant_id, received_at desc);
```

### 6.3 automation_runs

```sql
create table automation_runs (
  id uuid primary key,
  tenant_id uuid not null,
  user_id uuid,
  source_id uuid not null references automation_sources(id),
  event_id uuid not null references automation_events(id),
  devspace_conversation_id uuid,
  workspace_session_id uuid,
  context_window_id uuid,
  kind text not null,
  status text not null,
  input_text text,
  payload_redacted jsonb not null default '{}'::jsonb,
  result_summary text,
  error_code text,
  error_message text,
  retry_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
```

Suggested statuses:

```text
queued
running
succeeded
failed
canceled
ignored
duplicate
```

Suggested indexes:

```sql
create index automation_runs_tenant_status_idx
  on automation_runs (tenant_id, status, created_at desc);

create index automation_runs_workspace_idx
  on automation_runs (tenant_id, workspace_session_id, created_at desc);

create index automation_runs_conversation_idx
  on automation_runs (tenant_id, devspace_conversation_id, created_at desc);
```

## 7. Idempotency Rules

Idempotency key scope:

```text
source_id + idempotency_key
```

Source event id scope:

```text
source_id + source_event_id
```

Request fingerprint should include:

```text
trigger id or source id
event type
normalized text
normalized payload digest
conversationKey
workspaceHint
metadata
```

Duplicate behavior:

```text
Same source_event_id and same fingerprint:
  return the original event/run ids with duplicate=true

Same idempotency_key and same fingerprint:
  return the original event/run ids with duplicate=true

Same idempotency_key and different fingerprint:
  return 409 IDEMPOTENCY_CONFLICT

GitHub redelivery with same X-GitHub-Delivery:
  return the original event/run ids with duplicate=true
```

Retention:

```text
Keep automation events and runs for audit by default.
If retention is configured, preserve tombstone rows for idempotency until the
source-specific dedupe window expires.
```

## 8. Conversation And Workspace Routing

Automation ingress must not assume a current chat window.

Routing order:

```text
1. Resolve tenant and source from auth/signature.
2. Resolve source default user, local agent, repository, or workspace policy.
3. If conversationKey is supplied, look up a matching DevSpace conversation owned by the tenant/user.
4. If workspaceHint is supplied, validate it against source policy and allowed roots.
5. If exactly one workspace mapping is valid, link the automation run to that workspace session.
6. If mapping is ambiguous, store the run as queued/pending_selection.
7. If mapping is invalid, store the event and create an ignored or failed run with a stable error.
```

Do not create local file access from a webhook alone. A later worker must still
validate local agent availability, workspace ownership, allowed roots, and policy.

## 9. Redaction And Audit

Redact before persistence:

```text
Authorization headers
cookies
x-api-key
access tokens
refresh tokens
private keys
connection strings
password fields
known secret-looking values
```

Store:

```text
payload_digest for dedupe/debugging
payload_redacted for audit UI
source id, event type, request id, timestamps
routing decision
run status and error code
```

Do not store raw webhook bodies by default. If a deployment needs raw-body
retention for forensic reasons, store it behind an explicit encrypted blob
reference and short retention period.

## 10. Platform And Deployment Notes

The server-side automation ingress is platform independent. It should run the
same on Ubuntu/Linux, macOS, and Windows when started through Node.

Deployment requirements:

```text
Public webhook endpoints require HTTPS on a reachable host.
Local-only 127.0.0.1 endpoints require a tunnel or reverse proxy for external webhooks.
GitHub webhook signature verification must use the exact raw bytes received.
Body parsers must not mutate the body before signature verification.
```

Ubuntu/Linux and macOS environment example:

```bash
export DEVSPACE_AUTOMATION_BASE_URL="https://devspace.example.com"
export DEVSPACE_AUTOMATION_MAX_BODY_BYTES="262144"
```

Windows PowerShell environment example:

```powershell
$env:DEVSPACE_AUTOMATION_BASE_URL = "https://devspace.example.com"
$env:DEVSPACE_AUTOMATION_MAX_BODY_BYTES = "262144"
```

Runtime hook portability:

```text
Prefer HTTP callbacks or Node scripts for cross-platform hooks.
Do not make Bash-only hooks the product contract.
If shell hooks are added later, provide Bash and PowerShell examples.
Use URL/path normalization before matching workspace hints.
```

## 11. Security Rules

Minimum required controls:

```text
source-level enable/disable switch
secret rotation path
HMAC or bearer token verification
raw-body signature verification for GitHub
constant-time signature comparison
request size limits
source rate limits
payload redaction
idempotency conflict detection
tenant/user ownership checks before workspace routing
no local command execution from webhook receipt alone
audit log for every accepted, ignored, duplicate, and failed event
```

Dangerous defaults to avoid:

```text
Do not execute shell commands directly from a webhook payload.
Do not trust repository instructions as security policy.
Do not route by raw local filesystem path from the caller.
Do not allow a webhook to select another user's local agent.
Do not log tokens or full secret-bearing payloads.
Do not make non-2xx webhook responses for intentionally ignored GitHub events.
```

## 12. Implementation Sequence

Recommended next PRs:

```text
PR18: Automation Event Store
  migrations, store interfaces, unit tests, JSON-safe redaction helpers

PR19: Generic API Trigger
  POST /api/automation/triggers/{triggerId}/fire, auth, idempotency, accepted response

PR20: GitHub Webhook Receiver
  raw-body HMAC validation, supported PR/release events, source filters, event dedupe

PR21: Runtime Hook Callback
  internal hook protocol for PreToolUse, PostToolUse, PermissionRequest, PostCompact

PR22: Workspace Agents Optional Async Bridge
  outbound trigger helper, token secret ref, conversation_key generator, trigger audit log
```

Keep each implementation PR independently shippable. Do not add a background
worker until events, runs, and idempotency are stable.

## 13. Acceptance Criteria

The automation ingress line is ready when:

```text
HTTP triggers return stable 202 responses with automationRunId.
GitHub redeliveries are deduped by X-GitHub-Delivery.
Idempotency-Key conflicts return 409.
Payloads are redacted before durable storage.
Every accepted event creates an automation_event row.
Runnable events create an automation_run row.
Ignored events are still auditable.
Workspace routing never trusts caller-supplied user/session ids.
Runtime hooks can add audit/context and, where allowed, block risky actions.
Docs include Ubuntu/Linux, macOS, and Windows operator guidance.
Workspace Agents remain optional async integration, not the live local execution path.
Codex Responses proxy remains explicitly out of scope for this line.
```
