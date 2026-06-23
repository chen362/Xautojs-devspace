# Xautojs Cloud MCP Gateway Architecture

Last updated: 2026-06-24

## Product Decision

Xautojs DevSpace has two operating modes:

```text
Self-hosted local mode:
  ChatGPT or another MCP host connects directly to a user-managed DevSpace MCP URL.
  The user runs devspace serve locally and exposes it with a tunnel or reverse proxy.

Public customer mode:
  ChatGPT connects to an Xautojs Cloud MCP Gateway.
  Xautojs Desktop starts a local agent on the customer's machine.
  The local agent connects outbound to the cloud gateway and executes local file and shell tools.
```

For a public customer product, do not require every customer to expose their own `/mcp` endpoint to the public internet. The product should provide one stable cloud MCP endpoint for ChatGPT, while local file access and command execution remain on the customer's machine.

The cloud gateway is the protocol, identity, routing, and audit boundary. The local agent is the execution boundary.

## Current Repository Reality

The current implementation combines the MCP protocol server and local execution in one local process:

```text
src/cli.ts
  devspace serve
    -> load config
    -> start src/server.ts
    -> register automation, GitHub webhook, and native-agent APIs

src/server.ts
  /mcp Streamable HTTP transport
  OAuth owner-token or OIDC auth
  MCP session identity checks
  open_workspace and file/shell tool registration

src/workspaces.ts
  workspaceId lifecycle
  allowed root checks for opened workspaces
  AGENTS.md / CLAUDE.md loading
  managed worktree support

src/pi-tools.ts
  read/write/edit/grep/find/list/shell execution through pi-coding-agent tools

src/roots.ts
  allowedRoots path enforcement
```

Phase 1.1 implementation status:

```text
DevspaceToolExecutionContext now carries mcpSessionId and owner identity.
Workspace sessions persist mcp_session_id when a scoped MCP session opens a workspace.
Workspace restore, touch, and loaded-agent-file lookup can require the current MCP session scope.
A workspaceId created in one MCP session is rejected as unknown in another MCP session.
conversationSessionId, deviceId, and toolCallId remain reserved in the execution context for cloud mode.
```

Phase 1.2 implementation status:

```text
RemoteMcpToolExecutor now implements the same DevspaceToolExecutor contract as the local executor.
RemoteMcpToolTransport is an injected internal boundary for future device-channel routing.
Remote calls forward mcpSessionId, owner, optional conversationSessionId, deviceId, and toolCallId.
When toolCallId is absent, the remote executor creates a tc_ id for audit/idempotency plumbing.
Fake transport tests cover canonical tool routing, context forwarding, workspaceId forwarding, and remote error mapping.
No real WebSocket, device channel, or cloud gateway server is introduced in this phase.
```

Phase 1.3 implementation status:

```text
src/cloud-routing-contract.ts defines the cloud routing contract records, inputs, and stable errors.
src/cloud-routing-store.ts adds a CloudRoutingStore interface and in-memory skeleton implementation.
The store binds deviceId, workspaceId, mcpSessionId, optional conversationSessionId, owner, and toolCallId.
The store rejects workspaceId reuse across MCP sessions and rejects unknown, expired, or offline routes.
Tool calls can be resolved idempotently by toolCallId and conflicting reuse returns TOOL_CALL_CONFLICT.
Tests cover session isolation, owner isolation, unknown workspace errors, offline device routing, expiry, and toolCallId conflicts.
No real WebSocket gateway, device channel server, or database-backed cloud store is introduced in this phase.
```

Phase 2 implementation status:

```text
src/cloud-session-binding.ts binds mcpSessionId + optional conversationSessionId to a validated deviceId.
src/cloud-device-channel.ts defines the cloud-to-device channel interface without committing to WebSocket yet.
src/gateway-mcp-tool-executor.ts routes MCP tool calls through CloudRoutingStore and CloudDeviceChannel.
src/postgres-cloud-routing-store.ts implements the same routing contract with Postgres queries.
migrations/postgres/0005_cloud_agent_control_plane.sql creates cloud_devices, cloud_workspace_routes, and cloud_tool_calls.
Tests cover session pairing, device expiry/offline, Postgres route persistence, fake device routing, toolCall completion/failure, and local policy errors.
The gateway executor does not import pi-tools, resolve local absolute paths, or execute shell commands directly.
No real WebSocket gateway, cloud HTTP server, or Desktop outbound client is introduced in this phase.
```

This is correct for self-hosted use. Public customer mode needs an additional split:

```text
MCP protocol entrypoint -> cloud gateway
local file and shell execution -> customer local agent
```

## Target Topology

```text
ChatGPT Web
  |
  | MCP over HTTPS
  v
Xautojs Cloud MCP Gateway
  |
  | outbound device channel: WebSocket first, SSE/long-poll fallback later
  v
Xautojs Desktop
  |
  | starts, monitors, and stops
  v
Local DevSpace Agent
  |
  v
Customer workspace roots, files, git, npm, tests, shell commands
```

The customer machine never needs to expose a public inbound port. The local agent connects outbound to Xautojs Cloud, receives tool calls for explicitly approved workspace sessions, executes them locally, and streams results back.

## Trust Boundaries

Cloud Gateway responsibilities:

```text
MCP endpoint exposed to ChatGPT
OAuth and account/session entrypoint
conversation session creation
Desktop/device routing
workspace session routing
tool call idempotency and audit records
heartbeats and device online state
billing, quota, tenant policy, and rate limits
GitHub webhook and automation ingress when used
```

Cloud Gateway must not:

```text
read customer files directly
execute shell commands directly
store raw customer local absolute paths as the source of authority
trust a ChatGPT account as the sole isolation boundary
reuse a workspace session across MCP sessions
```

Local Agent responsibilities:

```text
registered local workspace roots
local path resolution
allowedRoots enforcement
open_workspace implementation
read/write/edit/search/list/shell tool execution
local process tree ownership
local approval prompts for risky operations
Desktop lifecycle drain and shutdown
```

Desktop responsibilities:

```text
customer login and device pairing
workspace root selection
starting and stopping the local agent
showing connection status
showing tool-call and approval prompts
closing the local service when the user exits Desktop by default
optional background mode for long-running tasks
```

## Shared ChatGPT Account Constraint

A single ChatGPT account may be shared by multiple real users or customer sessions. Do not use the ChatGPT account as the security boundary.

The stable isolation boundary must be Xautojs-owned:

```text
xautojsTenantId
xautojsUserId or customer seat id
conversationSessionId
mcpSessionId
deviceId
workspaceSessionId
toolCallId
```

The ChatGPT account can be kept as an optional audit hint, but it must not grant access to devices or workspaces by itself.

Correct isolation model:

```text
Same ChatGPT account
  conversation A -> Xautojs session A -> device A -> workspace A
  conversation B -> Xautojs session B -> device B -> workspace B
  conversation C -> Xautojs session C -> device C -> workspace C
```

Each conversation session must explicitly bind to a device and workspace session. A `workspaceId` returned in one MCP session must be rejected in every other MCP session.

## MCP Tool Contract In Public Mode

The public cloud MCP Gateway should keep the model-facing tool experience simple, but the tools must route through Xautojs session state.

Recommended tools:

```text
connect_desktop
list_devices
list_workspaces
open_workspace
read_file
write_file
edit_file
grep_files
find_files
list_directory
run_shell
show_changes
close_workspace
```

### connect_desktop

Purpose: start or resume binding between the current MCP session and a Desktop device.

Input:

```json
{
  "pairingCode": "optional short code shown in Desktop",
  "deviceId": "optional previously selected device"
}
```

Success response:

```json
{
  "status": "connected",
  "conversationSessionId": "conv_...",
  "deviceId": "dev_...",
  "deviceLabel": "Abba MacBook Pro",
  "expiresAt": "2026-06-24T12:00:00.000Z"
}
```

Failure codes:

```text
PAIRING_REQUIRED
PAIRING_DENIED
DEVICE_OFFLINE
DEVICE_NOT_FOUND
SESSION_EXPIRED
```

### list_workspaces

Purpose: list workspaces approved for the current conversation session and device.

The cloud response must not expose raw local absolute paths by default.

Success response:

```json
{
  "deviceId": "dev_...",
  "workspaces": [
    {
      "workspaceRef": "wsroot_...",
      "displayName": "Xautojs-devspace",
      "rootLabel": "~/Projects/Xautojs-devspace",
      "capabilities": ["read", "write", "shell", "worktree"]
    }
  ]
}
```

### open_workspace

Purpose: create an MCP workspace session scoped to the current conversation, device, and registered local workspace.

Input:

```json
{
  "deviceId": "dev_...",
  "workspaceRef": "wsroot_...",
  "mode": "checkout",
  "baseRef": "optional git ref for worktree mode"
}
```

Success response:

```json
{
  "workspaceId": "mcp_ws_...",
  "deviceId": "dev_...",
  "workspaceRef": "wsroot_...",
  "rootLabel": "Xautojs-devspace",
  "mode": "checkout",
  "agentsFiles": [],
  "availableAgentsFiles": [],
  "skills": [],
  "instruction": "Use this workspaceId in all subsequent tool calls for this project."
}
```

Rules:

```text
workspaceId is scoped to one mcpSessionId and one conversationSessionId.
workspaceId is not portable across ChatGPT windows or conversations.
workspaceRef must belong to the selected device.
The local agent performs the final workspaceRef -> localPath resolution.
The local agent still runs allowedRoots checks.
```

### File And Shell Tools

The existing tool contract can remain mostly compatible after `open_workspace`:

```json
{
  "workspaceId": "mcp_ws_...",
  "path": "src/server.ts"
}
```

Path rules:

```text
Tool paths must be relative to the opened workspace root.
Absolute paths from ChatGPT are rejected in public mode.
The cloud validates workspaceId ownership.
The local agent validates the resolved local path is inside the registered root.
```

`run_shell` must be treated as high risk. Public mode should keep the existing workspace-root working directory rules and add approval policy on top:

```text
read-only commands can run under policy
write/build/test commands can require Desktop approval depending on permission profile
destructive commands require explicit approval or are blocked
```

## Cloud To Local Agent Channel

Use an outbound WebSocket from the local agent to cloud for the first production design.

Connection start message:

```json
{
  "type": "agent.hello",
  "protocolVersion": 1,
  "deviceId": "dev_...",
  "desktopInstanceId": "desk_...",
  "agentVersion": "1.0.1",
  "capabilities": ["mcp-tools", "workspace-roots", "shell", "approvals"]
}
```

Heartbeat:

```json
{
  "type": "agent.heartbeat",
  "connectionId": "conn_...",
  "time": "2026-06-24T00:00:00.000Z"
}
```

Tool call:

```json
{
  "type": "tool.call",
  "toolCallId": "tc_...",
  "conversationSessionId": "conv_...",
  "mcpSessionId": "mcp_sess_...",
  "workspaceSessionId": "mcp_ws_...",
  "tool": "read_file",
  "input": {
    "path": "src/server.ts"
  },
  "deadlineAt": "2026-06-24T00:01:00.000Z"
}
```

Tool result:

```json
{
  "type": "tool.result",
  "toolCallId": "tc_...",
  "ok": true,
  "content": [
    { "type": "text", "text": "..." }
  ],
  "structuredContent": {
    "result": "..."
  }
}
```

Tool error:

```json
{
  "type": "tool.result",
  "toolCallId": "tc_...",
  "ok": false,
  "error": {
    "code": "LOCAL_PATH_DENIED",
    "message": "Path is outside the opened workspace.",
    "retryable": false
  }
}
```

Cancellation:

```json
{
  "type": "tool.cancel",
  "toolCallId": "tc_...",
  "reason": "mcp_client_disconnected"
}
```

## Error Model

Use stable cloud-facing errors and map them into MCP tool errors without leaking internal details.

```text
PAIRING_REQUIRED        retryable=false  The MCP session is not paired with a Desktop device.
PAIRING_DENIED          retryable=false  The Desktop user denied the session.
DEVICE_OFFLINE          retryable=true   The selected Desktop device is not connected.
DEVICE_BUSY             retryable=true   The device is online but cannot accept the call yet.
DEVICE_NOT_FOUND        retryable=false  The selected Desktop device is unknown or revoked for this owner.
DEVICE_FORBIDDEN        retryable=false  The MCP session is paired with another device or the device belongs to another owner.
WORKSPACE_NOT_FOUND     retryable=false  The workspaceRef or workspaceId is unknown.
WORKSPACE_FORBIDDEN     retryable=false  The current session cannot access this workspace.
SESSION_EXPIRED         retryable=false  The conversation, device, or workspace route expired.
TOOL_CALL_CONFLICT      retryable=false  The same toolCallId was reused for a different route or tool.
TOOL_TIMEOUT            retryable=true   The local agent did not finish before the deadline.
TOOL_CANCELLED          retryable=false  The call was cancelled by user, gateway, or session close.
AGENT_DISCONNECTED      retryable=true   The device channel closed while the call was running.
LOCAL_PATH_DENIED       retryable=false  The local agent rejected path access.
LOCAL_POLICY_BLOCKED    retryable=false  Local policy or approval denied the operation.
LOCAL_TOOL_FAILED       retryable=false  The tool ran and returned an expected failure.
GATEWAY_INTERNAL        retryable=true   Unexpected gateway error.
```

For retries:

```text
read/list/search tools may be retried with the same toolCallId if no result was committed.
write/edit/shell tools must not be automatically replayed with a new toolCallId.
write/edit/shell retries require idempotency handling or explicit user approval.
```

## Data Model

Minimum tables for public mode:

```text
tenants
users
conversation_sessions
devices
device_connections
registered_workspaces
workspace_sessions
tool_calls
tool_call_events
pairing_requests
approvals
```

Recommended fields:

```text
conversation_sessions:
  id
  tenant_id
  user_id
  external_account_hint
  mcp_session_id
  status
  created_at
  expires_at

 devices:
  id
  tenant_id
  user_id
  label
  public_key
  status
  last_seen_at
  revoked_at

 device_connections:
  id
  device_id
  connection_id
  status
  connected_at
  last_heartbeat_at
  disconnected_at

 registered_workspaces:
  id
  tenant_id
  user_id
  device_id
  workspace_ref
  display_name
  root_label
  local_path_hash
  capabilities
  status
  created_at
  revoked_at

 workspace_sessions:
  id
  tenant_id
  user_id
  conversation_session_id
  mcp_session_id
  device_id
  workspace_ref
  status
  created_at
  expires_at

 tool_calls:
  id
  tenant_id
  user_id
  conversation_session_id
  workspace_session_id
  device_id
  tool_name
  request_fingerprint
  status
  deadline_at
  started_at
  completed_at
```

Phase 1.3 and Phase 2 code skeletons map the control-plane subset first:

```text
CloudRoutingDeviceRecord -> cloud_devices routeable device state
CloudRoutingWorkspaceRouteRecord -> cloud_workspace_routes workspace-session routing subset
CloudRoutingToolCallRecord -> cloud_tool_calls idempotency and routing subset
CloudSessionBindingRecord -> in-memory MCP-session-to-device pairing until a dedicated session table lands
PostgresCloudRoutingStore -> Postgres implementation of the same CloudRoutingStore contract
GatewayMcpToolExecutor -> cloud executor that validates route state, then delegates to CloudDeviceChannel
CloudDeviceChannel -> future WebSocket/SSE/long-poll boundary; currently tested with a fake channel
```

`local_path_hash` is optional and for diagnostics only. The local absolute path remains authoritative only on the customer's machine.

## Desktop Lifecycle Contract

Default behavior:

```text
Desktop starts local agent when the app starts.
Local agent connects outbound to cloud.
Desktop shows online/offline and paired session state.
Desktop quitting drains and stops the local agent.
Cloud marks the device offline.
New tool calls return DEVICE_OFFLINE or SESSION_EXPIRED.
```

When active tool calls exist on quit:

```text
Default: prompt the user.
Options:
  cancel active tasks and quit
  wait for active tasks then quit
  keep agent running in background
```

Background mode is optional and should be explicit. Normal user expectation can remain: closing Desktop closes local service.

## Implementation Plan

### Phase 1: Extract Tool Executor Boundary

Create an internal executor interface and make current local behavior use it.

```text
src/mcp/tool-executor.ts
src/mcp/local-tool-executor.ts
src/mcp/register-tools.ts
```

Target interface:

```ts
export interface DevspaceToolExecutor {
  openWorkspace(input: OpenWorkspaceInput, context: ToolContext): Promise<OpenWorkspaceResult>;
  readFile(input: ReadFileInput, context: ToolContext): Promise<ToolResult>;
  writeFile(input: WriteFileInput, context: ToolContext): Promise<ToolResult>;
  editFile(input: EditFileInput, context: ToolContext): Promise<ToolResult>;
  grepFiles(input: GrepFilesInput, context: ToolContext): Promise<ToolResult>;
  findFiles(input: FindFilesInput, context: ToolContext): Promise<ToolResult>;
  listDirectory(input: ListDirectoryInput, context: ToolContext): Promise<ToolResult>;
  runShell(input: RunShellInput, context: ToolContext): Promise<ToolResult>;
}
```

`LocalToolExecutor` should reuse existing `WorkspaceRegistry`, `pi-tools`, and `roots` logic. This keeps self-hosted mode working while preparing cloud routing.

### Phase 1.3: Cloud Routing Contract And Store Skeleton

Before adding a real gateway, cloud routing must be a testable contract:

```text
src/cloud-routing-contract.ts
src/cloud-routing-store.ts
src/cloud-routing-store.test.ts
```

The store owns the route from owner + MCP session + optional conversation session + workspaceId to a routeable device. It also owns toolCallId idempotency before any transport writes to a future WebSocket or fallback channel.

Required behavior:

```text
same owner + different mcpSessionId cannot reuse a workspaceId
unknown workspaceId returns WORKSPACE_NOT_FOUND
known but wrong-session workspaceId returns WORKSPACE_FORBIDDEN
offline devices return DEVICE_OFFLINE and retryable=true
expired routes return SESSION_EXPIRED
a repeated toolCallId on the same route is idempotent
a repeated toolCallId on a different route returns TOOL_CALL_CONFLICT
```

### Phase 2: Cloud Agent Control Plane Skeleton

Make cloud mode testable without introducing a real WebSocket gateway yet.

```text
src/cloud-session-binding.ts
src/cloud-device-channel.ts
src/gateway-mcp-tool-executor.ts
src/postgres-cloud-routing-store.ts
migrations/postgres/0005_cloud_agent_control_plane.sql
```

Required behavior:

```text
MCP session must resolve to exactly one permitted device before open_workspace routes.
conversationSessionId and mcpSessionId remain part of every forwarded tool call.
GatewayMcpToolExecutor validates routing state before sending to a device channel.
GatewayMcpToolExecutor never imports pi-tools and never touches local paths or shell directly.
PostgresCloudRoutingStore preserves the same behavior as the in-memory CloudRoutingStore contract.
Fake CloudDeviceChannel tests prove route -> device -> result/error flow without a real transport.
```

This phase intentionally stops at a fake channel. The production WebSocket client/server can replace `CloudDeviceChannel` later without changing MCP tool handlers again.

### Phase 3: Preserve Self-Hosted Mode

`devspace serve` remains the self-hosted local MCP server:

```text
ChatGPT -> customer tunnel -> local devspace serve -> local files
```

No customer-visible behavior should break in this phase.

### Phase 4: Add Cloud Gateway Mode

Add a gateway server mode where MCP tool registration is the same, but executor implementation is remote:

```text
src/cloud/gateway-server.ts
src/cloud/device-channel-store.ts
src/cloud/websocket-device-channel.ts
```

The gateway server should use `GatewayMcpToolExecutor`, `CloudSessionBindingService`, and `CloudRoutingStore`. It accepts MCP requests, validates the current session, and sends tool calls to a connected device. It never imports `pi-tools` or touches local file paths.

### Phase 5: Add Local Agent Mode

Add a local agent process that Desktop can start:

```text
src/local-agent/agent.ts
src/local-agent/device-channel-client.ts
src/local-agent/workspace-registry.ts
```

The local agent receives tool calls, resolves workspaceRef locally, runs the existing local executor, and returns results.

### Phase 6: Desktop Supervisor

Tauri Desktop should manage the local agent lifecycle:

```text
start local agent on app ready
store device registration securely
show pairing prompts
show workspace authorization prompts
send graceful shutdown on quit
kill child process on forced quit
```

The Rust side should own process lifecycle. The renderer should not hold long-lived raw cloud secrets.

### Phase 7: CI And Release

CI should produce:

```text
xautojs-devspace npm package artifact
Xautojs Desktop installers
checksums
provenance attestations
```

Desktop installers should eventually include the local agent runtime so normal users do not install Node manually.

## Acceptance Criteria

Public customer mode is ready only when all of these hold:

```text
ChatGPT connects to one stable Xautojs MCP Gateway URL.
A shared ChatGPT account cannot cross-access another Xautojs conversation session.
Each MCP session must be explicitly paired with a Desktop device.
Each workspaceId is scoped to one conversation session and one device.
Cloud cannot execute local file or shell tools without a connected local agent.
Cloud does not need customer machines to expose inbound public ports.
Local agent enforces allowedRoots even if cloud routing is wrong.
Closing Desktop marks the device offline and stops local execution by default.
Tool calls have stable error codes, deadlines, cancellation, and audit records.
Self-hosted devspace serve remains supported for developer/local use.
```

## Recommended First Patch

Do not start by building the full cloud service. Start by extracting the executor boundary inside the current server.

First code milestone:

```text
src/server.ts no longer directly binds MCP tool handlers to WorkspaceRegistry/pi-tools.
Tool registration accepts a DevspaceToolExecutor.
LocalToolExecutor preserves current behavior.
Tests prove existing MCP local mode still opens workspaces, reads files, edits files, and runs shell commands.
```

This first milestone is now represented by the local executor, remote executor, cloud routing store, gateway executor, and fake channel tests. The next production milestone is replacing the fake device channel with a real outbound Desktop/local-agent channel while keeping the same contracts.
