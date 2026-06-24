# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3 through Phase 8 interfaces now present in the repository.

## Current Status

Phase 3 introduced the outbound channel control-plane skeleton. Phase 4 wired the first production-facing gateway pieces without changing the existing self-hosted `devspace serve` mode. Phase 5 added the first real auth adapter, Desktop-managed outbound lifecycle, and workspace catalog sync. Phase 6 added the first user-usable loop: device-code token issuing, Desktop cloud setup payload, catalog selection to workspace route binding, and audit/idempotency records for control-plane mutations.

Phase 7 turns the Phase 6 payload layer into a live-connection skeleton: persistent Postgres stores for device-code and audit/idempotency records, a small device-code HTTP API, a gateway HTTP route registration entrypoint, a Tauri lifecycle command bridge, a Desktop-side bridge client wired into the cloud settings panel, and local approval gates for write/edit/shell tool calls.

Phase 8 connects the Tauri lifecycle bridge to the real TypeScript Desktop outbound agent process. `start_cloud_lifecycle` now spawns `devspace-desktop-agent --stdin`, passes the cloud payload through stdin so the device token is not exposed in process arguments, and tracks the child process id. The new runner starts `DesktopOutboundAgentLifecycle`, reports the selected workspace catalog, maps cloud workspace ids back to local workspace roots, and keeps destructive tool calls denied by default until an interactive local approval bridge is attached. Phase 8 also adds a minimal `/cloud/device` user-code approval page and stops persisting the Desktop cloud device token to browser `localStorage`.

Implemented Phase 8 files:

```text
src/desktop-cloud-agent-runner.ts
src/desktop-cloud-agent-cli.ts
src/desktop-cloud-agent-runner.test.ts
src/cloud-device-code-api.ts
src/cloud-device-code-api.test.ts
apps/desktop/src-tauri/src/main.rs
apps/desktop/src/cloud-connection-client.ts
apps/desktop/src/cloud-connection-client.test.ts
package.json
```

Implemented Phase 7 files:

```text
migrations/postgres/0009_cloud_device_code_and_audit.sql
src/postgres-cloud-device-authorization-store.ts
src/postgres-cloud-control-plane-audit-store.ts
src/cloud-device-code-api.ts
src/cloud-gateway-server.ts
src/local-agent-receiver.ts
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src/tauri-cloud-lifecycle-client.ts
apps/desktop/src/App.tsx
src/postgres-cloud-device-authorization-store.test.ts
src/postgres-cloud-control-plane-audit-store.test.ts
src/cloud-device-code-api.test.ts
src/cloud-gateway-http-routes.test.ts
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
  -> user opens /cloud/device?user_code=XXXX-XXXX
  -> authenticated owner approves userCode
  -> POST /api/cloud/device-code/token returns signed device token
  -> Desktop cloud settings build DesktopCloudLifecyclePayload
  -> App.tsx Save setup calls startDesktopCloudLifecycle(payload)
  -> Tauri start_cloud_lifecycle command validates payload
  -> Tauri spawns devspace-desktop-agent --stdin and writes payload JSON to stdin
  -> desktop-cloud-agent-cli starts DesktopCloudAgentRunner
  -> DesktopCloudAgentRunner starts DesktopOutboundAgentLifecycle
  -> authenticated outbound Desktop/local agent WebSocket sends agent.hello
  -> workspace.catalog reports approved local workspaces
  -> ChatGPT MCP request calls connect_desktop/list_workspaces/connect_workspace
  -> CloudWorkspaceSelectionService binds workspace route with audit/idempotency
  -> GatewayMcpToolExecutor routes tool calls through WebSocketDeviceChannel
  -> LocalAgentToolReceiver
  -> local approval prompt policy for write/edit/shell
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`. Write, edit, and shell calls are locally gated by the approval prompt policy before they reach the executor.

## Gateway HTTP Route Registration

`cloud-gateway-server.ts` exposes `registerCloudGatewayHttpRoutes(app, runtime, config, options)`. This is the selected gateway-server registration point for HTTP routes that sit next to the WebSocket upgrade route.

Current registration:

```text
registerCloudGatewayHttpRoutes()
  -> registerCloudDeviceCodeApiRoutes()
  -> reuses runtime.auditStore
  -> default owner resolver accepts owner-token Bearer auth in local mode
  -> production deployments must inject a trusted resolveOwner adapter
```

The device-code API therefore shares the same control-plane audit store as `connect_desktop`, `connect_workspace`, and gateway-routed tool calls. It also keeps the authenticated owner source outside the request body. Gateway-injected owner headers or hosted IdP claims are only trusted when the deployment passes an explicit `resolveOwner` adapter; they are not accepted by the default resolver.

## Device-Code HTTP API

`cloud-device-code-api.ts` registers a small HTTP API plus a minimal browser approval page:

```text
GET  /cloud/device?user_code=XXXX-XXXX
POST /api/cloud/device-code
POST /api/cloud/device-code/token
POST /api/cloud/device-code/:userCode/approve
POST /api/cloud/device-code/:userCode/deny
```

Contract:

```text
create body: clientName optional, deviceId optional, desktopInstanceId optional
create response: deviceCode, userCode, verificationUri, verificationUriComplete, expiresAt, expiresInSeconds, intervalSeconds, requestId
approval page: renders forms for the supplied userCode; owner still comes only from authenticated request resolver on submit
poll body: deviceCode required
poll success: accessToken, tokenType=Bearer, expiresAt, owner, deviceId optional, desktopInstanceId optional, requestId
approve identity: owner comes only from the injected authenticated request resolver
approve body: deviceId optional, desktopInstanceId optional
approve form body: urlencoded deviceId optional, desktopInstanceId optional; success renders a small HTML result page
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

`createCloudGatewayRuntime()` defaults to `PostgresCloudControlPlaneAuditStore` when the server database config is Postgres. Non-Postgres local harnesses still use the in-memory audit store.

## Desktop Lifecycle Bridge

The Tauri backend exposes lifecycle commands:

```text
start_cloud_lifecycle(payload)
stop_cloud_lifecycle()
get_cloud_lifecycle()
```

The command state is intentionally small and stable:

```text
status: running/stopped/error
url
deviceId
desktopInstanceId
workspaceCount
processId
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

`App.tsx` wires the cloud settings panel to that bridge: Save setup validates and stores the non-secret cloud settings, calls `startDesktopCloudLifecycle(payload)`, and reflects `running`, `unsupported`, and `error` bridge states in the panel. Stop calls `stopDesktopCloudLifecycle()` and kills the Desktop outbound agent child process. When the app is running in a plain browser dev session, the client returns `status: unsupported` instead of throwing. In a real Tauri WebView it calls the Rust commands through the global Tauri bridge. The CSP allows localhost and cloud WebSocket connections.

`start_cloud_lifecycle` starts the TypeScript outbound client by spawning `devspace-desktop-agent --stdin`. The cloud payload is written to stdin, not argv, so the device token is not exposed in process listings. The command can be overridden for packaged or development builds with:

```text
DEVSPACE_DESKTOP_AGENT_COMMAND
DEVSPACE_DESKTOP_AGENT_ARGS
```

`package.json` exposes the runner as a second npm binary:

```text
devspace-desktop-agent -> dist/desktop-cloud-agent-cli.js
```

## Desktop Cloud Agent Runner

`src/desktop-cloud-agent-runner.ts` is the Desktop-owned process boundary. It performs four jobs:

```text
normalize DesktopCloudLifecyclePayload
create a local WorkspaceRegistry limited to the selected local roots
start DesktopOutboundAgentLifecycle with Bearer device token auth
map routed cloud workspace ids back to local workspace roots before invoking LocalMcpToolExecutor
```

Cloud workspace ids are recomputed from owner, MCP session, optional conversation session, device id, and workspaceRef. This preserves the session-scoped workspace isolation model while allowing the local agent to open the real customer filesystem root only after the cloud route has already selected an approved catalog entry.

Default destructive approval mode is `deny`. Development smoke tests may opt in to automatic approval with:

```text
DEVSPACE_DESKTOP_APPROVAL_MODE=auto_approve
```

That override is intentionally not the production default.

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

## Token Storage Boundary

Desktop cloud connection settings continue to store non-secret connection preferences locally:

```text
gatewayUrl
deviceId
desktopInstanceId
workspaceCatalogText
```

The cloud device token is no longer persisted to browser `localStorage`. It is used from the current settings state to start the outbound lifecycle, then passed to the runner through stdin. Full OS keychain storage is still open; until it lands, token persistence should be treated as memory-only Desktop session state.

## Tests

The Phase 3 through Phase 8 tests cover:

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
device-code approval page rendering and urlencoded approve form flow
gateway HTTP route registration for device-code owner-token auth, custom owner resolver auth, token minting, and audit reuse
Postgres device authorization persistence
Postgres audit/idempotency replay and conflict behavior
workspace catalog selection -> workspace route binding and idempotent replay
Desktop cloud settings URL normalization, catalog parsing, lifecycle payload construction, and token non-persistence
Tauri cloud lifecycle client supported/unsupported start/stop/get behavior
Desktop cloud agent runner workspace mapping, bearer header forwarding, hello, and workspace.catalog emission
LocalAgentToolReceiver approval prompt allow/deny behavior
```

## Non-Goals Still Open

```text
No full external IdP/OIDC approval-page adapter yet
No Rust-owned WebSocket implementation; DesktopOutboundAgentLifecycle remains the TypeScript outbound client boundary
No interactive Desktop approval modal bridged from LocalAgentToolReceiver yet
No OS keychain/secure storage for Desktop device token yet; token is intentionally not persisted to localStorage
No packaged sidecar resolution policy beyond DEVSPACE_DESKTOP_AGENT_COMMAND/ARGS override yet
No cloud billing/quota event stream yet
```

## Next Production Phase

The next phase should finish the customer-grade Desktop loop around the now-live process boundary:

```text
add OS keychain storage for the Desktop device token
add an interactive Desktop approval modal wired to LocalAgentToolReceiver approvalPrompt
plug a production OIDC/hosted-auth resolveOwner adapter into registerCloudGatewayHttpRoutes()
package devspace-desktop-agent as a known Desktop sidecar path instead of relying only on PATH/overrides
keep self-hosted devspace serve as the local-only mode
```
