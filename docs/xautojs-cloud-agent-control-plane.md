# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3 through Phase 7 interfaces now present in the repository.

## Current Status

Phase 3 introduced the outbound channel control-plane skeleton. Phase 4 wired the first production-facing gateway pieces without changing the existing self-hosted `devspace serve` mode. Phase 5 added the first real auth adapter, Desktop-managed outbound lifecycle, and workspace catalog sync. Phase 6 added the first user-usable loop: device-code token issuing, Desktop cloud setup payload, catalog selection to workspace route binding, and audit/idempotency records for control-plane mutations.

Phase 7 turns the Phase 6 payload layer into a live-connection skeleton: persistent Postgres stores for device-code and audit/idempotency records, a small device-code HTTP API, a Tauri lifecycle command bridge, a Desktop-side bridge client, and local approval gates for write/edit/shell tool calls.

Implemented Phase 7 files:

```text
migrations/postgres/0009_cloud_device_code_and_audit.sql
src/postgres-cloud-device-authorization-store.ts
src/postgres-cloud-control-plane-audit-store.ts
src/cloud-device-code-api.ts
src/local-agent-receiver.ts
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src/tauri-cloud-lifecycle-client.ts
src/postgres-cloud-device-authorization-store.test.ts
src/postgres-cloud-control-plane-audit-store.test.ts
src/cloud-device-code-api.test.ts
src/local-agent-receiver-approval.test.ts
apps/desktop/src/tauri-cloud-lifecycle-client.test.ts
```

Implemented Phase 6 files:

```text
src/cloud-control-plane-audit.ts
src/cloud-device-code-auth.ts
src/cloud-workspace-selection-service.ts
apps/desktop/src/cloud-connection-client.ts
src/cloud-control-plane-audit.test.ts
src/cloud-device-code-auth.test.ts
src/cloud-workspace-selection-service.test.ts
apps/desktop/src/cloud-connection-client.test.ts
```

Implemented Phase 5 files:

```text
src/cloud-gateway-auth.ts
src/cloud-workspace-catalog-store.ts
src/postgres-cloud-workspace-catalog-store.ts
src/desktop-outbound-agent-lifecycle.ts
migrations/postgres/0008_cloud_workspace_catalog.sql
src/cloud-gateway-auth.test.ts
src/cloud-workspace-catalog-store.test.ts
src/postgres-cloud-workspace-catalog-store.test.ts
src/desktop-outbound-agent-lifecycle.test.ts
```

Implemented Phase 4 files:

```text
src/cloud-device-connection-store.ts
src/postgres-cloud-device-connection-store.ts
src/cloud-device-websocket-route.ts
src/cloud-desktop-tool-service.ts
src/cloud-desktop-mcp-tools.ts
src/local-agent-outbound-client.ts
src/ws-shim.d.ts
migrations/postgres/0007_cloud_device_connections.sql
src/postgres-cloud-device-connection-store.test.ts
src/cloud-production-gateway-wiring.test.ts
src/local-agent-outbound-client.test.ts
```

Existing Phase 3 files:

```text
src/cloud-device-channel-protocol.ts
src/cloud-device-channel.ts
src/websocket-device-channel.ts
src/local-agent-receiver.ts
src/cloud-gateway-server.ts
src/postgres-cloud-session-binding.ts
migrations/postgres/0006_cloud_session_bindings.sql
src/websocket-device-channel.test.ts
src/cloud-agent-control-plane.test.ts
src/postgres-cloud-session-binding.test.ts
```

## Runtime Shape

```text
Desktop device-code request
  -> POST /api/cloud/device-code
  -> CloudDeviceAuthorizationService.create()
  -> authenticated owner approves userCode
  -> POST /api/cloud/device-code/token returns signed device token
  -> Desktop cloud settings build DesktopCloudLifecyclePayload
  -> Tauri start_cloud_lifecycle command stores lifecycle state
  -> DesktopOutboundAgentLifecycle can start authenticated WebSocket client
  -> workspace.catalog reports approved local workspaces
  -> ChatGPT MCP request calls connect_desktop/list_workspaces/connect_workspace
  -> CloudWorkspaceSelectionService binds workspace route with audit/idempotency
  -> GatewayMcpToolExecutor routes tool calls through WebSocketDeviceChannel
  -> authenticated outbound Desktop/local agent WebSocket
  -> LocalAgentToolReceiver
  -> optional local approval prompt for write/edit/shell
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`. Phase 7 adds an optional approval prompt before `write_file`, `edit_file`, and `run_shell`; read/search/list/show-changes stay uninterrupted.

## Device-Code HTTP API

`cloud-device-code-api.ts` registers a small HTTP API:

```text
POST /api/cloud/device-code
POST /api/cloud/device-code/token
POST /api/cloud/device-code/:userCode/approve
POST /api/cloud/device-code/:userCode/deny
```

Contract:

```text
create body: clientName optional, deviceId optional, desktopInstanceId optional
create response: deviceCode, userCode, verificationUri, verificationUriComplete, expiresAt, expiresInSeconds, intervalSeconds, requestId
poll body: deviceCode required
poll success: accessToken, tokenType=Bearer, expiresAt, owner, deviceId optional, desktopInstanceId optional, requestId
approve identity: owner comes only from the injected authenticated request resolver
approve body: deviceId optional, desktopInstanceId optional
deny identity: owner comes only from the injected authenticated request resolver
```

Stable error body:

```json
{
  "error": {
    "code": "ACCESS_DENIED",
    "message": "Authenticated owner context is required.",
    "retryable": false,
    "requestId": "..."
  }
}
```

Stable device-code errors:

```text
AUTHORIZATION_PENDING -> HTTP 202 retryable=true
SLOW_DOWN -> HTTP 429 retryable=true
EXPIRED_TOKEN -> HTTP 400
ACCESS_DENIED -> HTTP 403
INVALID_DEVICE_CODE -> HTTP 404
INVALID_USER_CODE -> HTTP 404
INVALID_REQUEST -> HTTP 400
```

The issued access token uses the existing signed gateway device token format from `cloud-gateway-auth.ts`, so the WebSocket upgrade route can accept tokens minted by the device-code flow without changing the route contract.

## Persistent Stores

Phase 7 adds Postgres persistence for the user-code/token loop and control-plane audit/idempotency records.

```text
cloud_device_authorizations
  device_code primary key
  user_code unique
  status pending/approved/denied
  optional device identity
  optional owner tenant/user after approval
  expiry, poll interval, approval/denial/poll timestamps

cloud_control_plane_audit_events
  event_id primary key
  optional owner tenant/user
  action/status
  optional idempotency_key
  optional request_fingerprint
  result_json
  error_code
  created_at
```

`createCloudGatewayRuntime()` now defaults to `PostgresCloudControlPlaneAuditStore` when the server database config is Postgres. Non-Postgres local harnesses still use the in-memory audit store.

## Desktop Lifecycle Bridge

The Tauri backend now exposes lifecycle commands:

```text
start_cloud_lifecycle(payload)
stop_cloud_lifecycle()
get_cloud_lifecycle()
```

The command state is intentionally small and stable:

```text
status: running/stopped
url
deviceId
desktopInstanceId
workspaceCount
startedAt
stoppedAt
lastError
```

`apps/desktop/src/tauri-cloud-lifecycle-client.ts` provides a no-extra-dependency client for the WebView:

```text
startDesktopCloudLifecycle(payload)
stopDesktopCloudLifecycle()
getDesktopCloudLifecycle()
```

When the app is running in a plain browser dev session, the client returns `status: unsupported` instead of throwing. In a real Tauri WebView it calls the Rust commands through the global Tauri bridge. The CSP now allows localhost and cloud WebSocket connections.

The remaining UI integration is small and explicit: `App.tsx` should call `startDesktopCloudLifecycle(payload)` after `buildDesktopCloudLifecyclePayload()` and call `stopDesktopCloudLifecycle()` from the Stop button. The bridge and tests are in place; the current settings panel still treats the payload as ready state until that final UI call is wired.

## Local Approval Prompt

`LocalAgentToolReceiver` accepts an optional `approvalPrompt`:

```text
requestApproval({ toolCallId, tool, workspaceId, context, input, risk, title, message })
```

Risk rules:

```text
write_file -> medium
edit_file -> medium
run_shell -> high
read_file/grep_files/find_files/list_directory/show_changes -> no prompt
```

Denied approvals return a `tool.result` error:

```text
code: LOCAL_APPROVAL_DENIED
retryable: false
```

This keeps customer-machine destructive actions gated locally, even when the cloud route and Desktop connection are valid.

## Desktop MCP Tools

`registerCloudDesktopMcpTools()` registers four cloud-mode tools:

```text
connect_desktop: bind the current MCP session to one online device
list_devices: list visible Desktop/local agent devices for the authenticated owner
list_workspaces: list catalog entries reported by the connected Desktop/local agent
connect_workspace: bind a selected workspaceRef to a routeable workspaceId
```

`connect_desktop` is idempotent for the same session/device pairing. When more than one device is online, callers must pass `deviceId` from `list_devices`.

`connect_workspace` accepts an optional `idempotencyKey` so ChatGPT retries can be retried safely without creating a different workspace route.

## Tests

The Phase 3 through Phase 7 tests cover:

```text
heartbeat updates and capability normalization
cancel forwarding
tool.call -> tool.result correlation
tool timeout error mapping
GatewayMcpToolExecutor -> WebSocketDeviceChannel -> LocalAgentToolReceiver -> DevspaceToolExecutor loop
read/write/shell route completion
disconnected device mapping to AGENT_DISCONNECTED and failed toolCall status
Postgres session binding persistence and isolation errors
Postgres device connection persistence and owner isolation
signed device token verification, expiry, and bearer extraction
workspace catalog normalization, owner isolation, snapshot replacement, and Postgres persistence
real HTTP WebSocket upgrade route registration, authenticated hello, catalog, heartbeat, close/offline state
local outbound client hello, heartbeat, workspace.catalog, tool.call, tool.result, and stop lifecycle
Desktop outbound lifecycle start/restart/stop and bearer header injection
device-code pending, slow_down, approval, token minting, denial, and expiry
device-code HTTP create/poll/approve/deny flow
Postgres device authorization persistence
Postgres audit/idempotency replay and conflict behavior
workspace catalog selection -> workspace route binding and idempotent replay
Desktop cloud settings URL normalization, catalog parsing, and lifecycle payload construction
Tauri cloud lifecycle client supported/unsupported start/stop/get behavior
LocalAgentToolReceiver approval prompt allow/deny behavior
```

## Non-Goals Still Open

```text
No hosted browser verification page for userCode approval yet
No full external IdP/OIDC approval-page adapter yet
No App.tsx direct call into the new Tauri lifecycle client yet
No Rust-owned WebSocket implementation; DesktopOutboundAgentLifecycle remains the TypeScript outbound client boundary
No cloud billing/quota event stream yet
```

## Next Production Phase

The next phase should finish the user-facing live loop:

```text
wire App.tsx Save setup -> startDesktopCloudLifecycle(payload)
wire App.tsx Stop -> stopDesktopCloudLifecycle()
register device-code API in the selected cloud gateway server entrypoint with a real authenticated owner resolver
add a minimal verification page for userCode approval
replace localStorage device-token handling with OS keychain/secure storage
connect Tauri lifecycle command to DesktopOutboundAgentLifecycle start/stop when the Desktop runtime boundary is finalized
keep self-hosted devspace serve as the local-only mode
```
