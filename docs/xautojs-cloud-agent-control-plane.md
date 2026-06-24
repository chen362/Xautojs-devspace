# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3, Phase 4, and Phase 5 interfaces now present in the repository.

## Current Status

Phase 3 introduced the outbound channel control-plane skeleton. Phase 4 wired the first production-facing gateway pieces without changing the existing self-hosted `devspace serve` mode. Phase 5 adds the first real auth adapter, Desktop-managed outbound lifecycle, and workspace catalog sync.

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
ChatGPT MCP request
  -> cloud MCP gateway server mode
  -> connect_desktop/list_devices/list_workspaces MCP tools when pairing is needed
  -> GatewayMcpToolExecutor
  -> CloudRoutingStore
  -> CloudSessionBindingService
  -> WebSocketDeviceChannel
  -> authenticated outbound Desktop/local agent WebSocket
  -> DesktopOutboundAgentLifecycle
  -> LocalAgentOutboundClient
  -> LocalAgentToolReceiver
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`, which can be the existing local executor.

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

This catalog is only discovery metadata. It does not by itself authorize file access. Routed tool calls still pass through session binding, workspace routing, device routing, and local executor checks.

## Desktop MCP Tools

`registerCloudDesktopMcpTools()` registers three cloud-mode tools:

```text
connect_desktop: bind the current MCP session to one online device
list_devices: list visible Desktop/local agent devices for the authenticated owner
list_workspaces: list catalog entries reported by the connected Desktop/local agent
```

`connect_desktop` is idempotent for the same session/device pairing. When more than one device is online, callers must pass `deviceId` from `list_devices`.

`list_workspaces` now returns `catalogPending: true` only when the connected device has not reported a workspace catalog yet.

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
CloudDesktopToolService
GatewayMcpToolExecutor
```

Default behavior:

```text
Postgres database config -> Postgres stores for routing, session bindings, device connections, and workspace catalog
Non-Postgres config -> in-memory stores for tests and local harnesses
No Desktop UI is created by the cloud runtime
Self-hosted devspace serve is unchanged
```

The production gateway server should inject `runtime.toolExecutor` into the cloud MCP server registration path, register `connect_desktop/list_devices/list_workspaces`, attach `attachCloudDeviceWebSocketRoute()` to its HTTP server, and provide `createSignedCloudDeviceWebSocketAuthenticator()` or a stronger external auth adapter.

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

The Phase 3, Phase 4, and Phase 5 tests cover:

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
```

## Non-Goals Still Open

```text
No Desktop UI pairing screen yet
No browser-visible account/device linking flow yet
No external IdP/OAuth device-code flow yet
No workspace open/bind flow from catalog entry to cloud workspace route yet
No cloud billing/quota/audit event stream yet
No local approval prompt UI yet
```

## Next Production Phase

The next phase should connect this wiring to user-facing product flows:

```text
bind the cloud MCP server process to GatewayMcpToolExecutor and cloud desktop tools
add the real gateway auth issuer endpoint or external IdP adapter for Desktop tokens
add Desktop UI/settings wrapper around DesktopOutboundAgentLifecycle
add workspace catalog selection -> workspace route binding
add audit/idempotency events around connect_desktop, workspace selection, and routed tool calls
keep self-hosted devspace serve as the local-only mode
```