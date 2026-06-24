# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3 through Phase 6 interfaces now present in the repository.

## Current Status

Phase 3 introduced the outbound channel control-plane skeleton. Phase 4 wired the first production-facing gateway pieces without changing the existing self-hosted `devspace serve` mode. Phase 5 added the first real auth adapter, Desktop-managed outbound lifecycle, and workspace catalog sync. Phase 6 now adds the first user-usable loop: device-code token issuing, Desktop cloud setup payload, catalog selection to workspace route binding, and audit/idempotency records for control-plane mutations.

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
  -> CloudDeviceAuthorizationService.create()
  -> user approves code for an authenticated owner
  -> CloudDeviceAuthorizationService.poll() returns a signed device token
  -> Desktop cloud settings save gateway/device/token/catalog payload
  -> Desktop outbound lifecycle starts authenticated WebSocket client
  -> workspace.catalog reports approved local workspaces
  -> ChatGPT MCP request calls connect_desktop/list_workspaces/connect_workspace
  -> CloudWorkspaceSelectionService binds workspace route with audit/idempotency
  -> GatewayMcpToolExecutor routes tool calls through WebSocketDeviceChannel
  -> authenticated outbound Desktop/local agent WebSocket
  -> DesktopOutboundAgentLifecycle
  -> LocalAgentOutboundClient
  -> LocalAgentToolReceiver
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`, which can be the existing local executor.

## Device-Code Token Issuer

`cloud-device-code-auth.ts` provides the first gateway-side device-code token issuer skeleton.

Contract:

```text
create(input) -> deviceCode, userCode, verificationUri, expiresAt, intervalSeconds
approve(userCode, owner) -> binds the pending device code to the authenticated owner
poll(deviceCode) -> pending/slow_down/denied/expired errors or a signed Bearer token
```

Stable error codes:

```text
AUTHORIZATION_PENDING retryable=true
SLOW_DOWN retryable=true
EXPIRED_TOKEN
ACCESS_DENIED
INVALID_DEVICE_CODE
INVALID_USER_CODE
```

The issued access token uses the existing signed gateway device token format from `cloud-gateway-auth.ts`, so the WebSocket upgrade route can accept tokens minted by the device-code flow without changing the route contract.

## Gateway Auth

`cloud-gateway-auth.ts` provides a signed device-token adapter for the WebSocket upgrade route.

Token rules:

```text
format: v1.<base64url-json-payload>.<hmac-sha256-signature>
signing secret: gateway-controlled shared secret
trusted owner source: signed token, not agent.hello
deviceId may be bound in the token
expiresAt is enforced before the WebSocket is accepted
```

`attachCloudDeviceWebSocketRoute()` now accepts auth context with:

```text
owner
deviceId optional
desktopInstanceId optional
expiresAt optional
```

If the token binds `deviceId` or `desktopInstanceId`, the first `agent.hello` must match those values. A mismatch closes the socket with policy violation semantics.

## Production Gateway Wiring

`attachCloudDeviceWebSocketRoute()` adds a real HTTP WebSocket upgrade route for outbound local agents:

```text
default path: /cloud/devices/ws
authenticate(request) -> signed owner/device context
first message must be agent.hello
heartbeat updates device status and connection state
workspace.catalog updates the device workspace catalog
socket close marks the device offline
```

The device must not self-report the owner in `agent.hello`. The owner comes only from the gateway auth adapter.

## Device Connection Persistence

`CloudDeviceConnectionStore` records currently known Desktop/local agent connections separately from workspace routes and session bindings.

Persisted fields:

```text
owner tenant/user
deviceId
connectionId
status online/offline
capabilities
desktopInstanceId
agentVersion
connectedAt
lastHeartbeatAt
disconnectedAt
```

Postgres storage lives in `cloud_device_connections` and is provided by `PostgresCloudDeviceConnectionStore`. The in-memory store remains available for tests and local harnesses.

## Workspace Catalog Sync

`workspace.catalog` is an agent-to-gateway protocol message. It reports the Desktop/local agent's currently approved workspace catalog for a device.

Catalog entries contain:

```text
workspaceRef
displayName
rootLabel
capabilities
catalogVersion optional
lastSeenAt from gateway receive time
```

Postgres storage lives in `cloud_workspace_catalog` and is provided by `PostgresCloudWorkspaceCatalogStore`. A new catalog snapshot replaces the previous snapshot for the same owner/device.

This catalog is only discovery metadata. It does not by itself authorize file access. Routed tool calls still pass through session binding, workspace routing, device routing, local executor checks, and Phase 6 workspace route selection.

## Workspace Route Selection

`CloudWorkspaceSelectionService` is the Phase 6 service that turns a selected catalog entry into a workspace route for the current MCP session.

Stable rules:

```text
input.workspaceRef is required
current MCP session must already be paired to an online device
workspaceRef must exist in that device's reported catalog
workspaceId is deterministic when caller does not supply one
same idempotencyKey + same request replays the first result
same idempotencyKey + different request returns TOOL_CALL_CONFLICT
unknown workspaceRef returns WORKSPACE_NOT_FOUND
```

The deterministic workspace id is scoped by owner, MCP session, conversation session, device, and workspaceRef. That keeps shared ChatGPT-account usage from accidentally reusing a route across sessions or devices.

## Control-Plane Audit And Idempotency

`CloudControlPlaneAuditStore` records control-plane mutations and idempotent outcomes.

Currently tracked actions:

```text
device_code.create
device_code.approve
device_code.poll
connect_desktop
connect_workspace
route_tool_call
```

The in-memory audit store is present for tests and local harnesses. Production persistence is intentionally still a follow-up so the event schema can settle before adding a Postgres migration.

## Desktop MCP Tools

`registerCloudDesktopMcpTools()` registers four cloud-mode tools:

```text
connect_desktop: bind the current MCP session to one online device
list_devices: list visible Desktop/local agent devices for the authenticated owner
list_workspaces: list catalog entries reported by the connected Desktop/local agent
connect_workspace: bind a selected workspaceRef to a routeable workspaceId
```

`connect_desktop` is idempotent for the same session/device pairing. When more than one device is online, callers must pass `deviceId` from `list_devices`.

`list_workspaces` returns `catalogPending: true` only when the connected device has not reported a workspace catalog yet.

`connect_workspace` accepts an optional `idempotencyKey` so ChatGPT retries can be retried safely without creating a different workspace route.

## Desktop Cloud Settings

The Desktop app now includes a cloud setup panel backed by `apps/desktop/src/cloud-connection-client.ts`.

The panel stores:

```text
gateway WebSocket URL
deviceId
desktopInstanceId optional
device token
workspace catalog text
```

Saving the panel validates and builds a `DesktopCloudLifecyclePayload` that matches the `DesktopOutboundAgentLifecycle.start()` shape: normalized WebSocket URL, bearer token, device identity, and workspace catalog snapshot. The UI does not yet directly start the Rust/Tauri-managed outbound client; that bridge is still a product integration step.

## Local Agent Outbound Client

`LocalAgentOutboundClient` is the Desktop/local-agent-side WebSocket client:

```text
connect to the cloud WebSocket URL
send agent.hello on open
send agent.heartbeat on an interval
send workspace.catalog on open and on a refresh interval when a catalog provider is configured
receive tool.call and tool.cancel
execute through LocalAgentToolReceiver
send tool.result back to the gateway
```

`DesktopOutboundAgentLifecycle` wraps this client for Desktop ownership:

```text
start(config): creates the client, injects Authorization: Bearer <token>, and starts it
stop(reason): closes the current socket and clears timers
restart(): rebuilds the client using the last normalized config
publishWorkspaceCatalog(): forces an immediate catalog sync
current(): returns a small lifecycle snapshot
```

The socket factory remains injectable so tests can run without a real network connection and Desktop can later provide its own Tauri lifecycle wrapper.

## Protocol Messages

The stable channel protocol lives in `src/cloud-device-channel-protocol.ts`.

Gateway to agent:

```text
tool.call
tool.cancel
```

Agent to gateway:

```text
agent.hello
agent.heartbeat
workspace.catalog
tool.result
```

Every `tool.call` carries:

```text
protocolVersion
deviceId
toolCallId
tool
context.owner
context.mcpSessionId
context.conversationSessionId
context.deviceId
context.toolCallId
workspaceId when the tool is workspace-scoped
input
deadlineAt when provided
```

## Gateway Runtime Contract

`createCloudGatewayRuntime()` builds the cloud control plane pieces:

```text
CloudRoutingStore
CloudSessionBindingService
CloudDeviceChannel
CloudDeviceConnectionStore
CloudWorkspaceCatalogStore
CloudControlPlaneAuditStore
CloudWorkspaceSelectionService
CloudDesktopToolService
GatewayMcpToolExecutor
```

Default behavior:

```text
Postgres database config -> Postgres stores for routing, session bindings, device connections, and workspace catalog
Non-Postgres config -> in-memory stores for tests and local harnesses
Audit store remains in-memory until the production audit schema lands
No Desktop UI is created by the cloud runtime
Self-hosted devspace serve is unchanged
```

The production gateway server should inject `runtime.toolExecutor` into the cloud MCP server registration path, register `connect_desktop/list_devices/list_workspaces/connect_workspace`, attach `attachCloudDeviceWebSocketRoute()` to its HTTP server, and provide `CloudDeviceAuthorizationService` plus `createSignedCloudDeviceWebSocketAuthenticator()` or a stronger external auth adapter.

## Postgres Session Binding

`PostgresCloudSessionBindingService` persists the MCP-session-to-device pairing in `cloud_session_bindings`.

Primary key:

```text
tenant_id + user_id + mcp_session_id
```

Stable rules:

```text
unpaired MCP session -> PAIRING_REQUIRED
same MCP session + different conversationSessionId -> WORKSPACE_FORBIDDEN
same MCP session + different deviceId -> DEVICE_FORBIDDEN
unknown or revoked device -> DEVICE_NOT_FOUND
offline device -> DEVICE_OFFLINE retryable=true
expired binding or device route -> SESSION_EXPIRED
```

## Tests

The Phase 3 through Phase 6 tests cover:

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
audit idempotency replay and conflict behavior
workspace catalog selection -> workspace route binding and idempotent replay
Desktop cloud settings URL normalization, catalog parsing, and lifecycle payload construction
```

## Non-Goals Still Open

```text
No hosted browser verification page for userCode approval yet
No persistent Postgres audit/idempotency store yet
No persistent Postgres device-code authorization store yet
No external IdP/OAuth provider adapter yet
No Tauri command bridge that starts DesktopOutboundAgentLifecycle from the settings panel yet
No local approval prompt UI yet
No cloud billing/quota event stream yet
```

## Next Production Phase

The next phase should turn the Phase 6 loop from settings/payload into a live Desktop-managed connection:

```text
add Postgres-backed device-code authorization and audit/idempotency stores
add a small gateway HTTP API for device-code create/poll and userCode approval
add the Tauri command bridge that starts/stops DesktopOutboundAgentLifecycle from the settings panel
bind the cloud MCP server process to GatewayMcpToolExecutor and all cloud desktop tools
add local approval prompts for write/edit/shell risk gates
keep self-hosted devspace serve as the local-only mode
```