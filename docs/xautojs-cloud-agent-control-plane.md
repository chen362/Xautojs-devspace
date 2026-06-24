# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3 and Phase 4 interfaces now present in the repository.

## Current Status

Phase 3 introduced the outbound channel control-plane skeleton. Phase 4 wires the first production-facing gateway pieces without changing the existing self-hosted `devspace serve` mode.

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
  -> LocalAgentOutboundClient
  -> LocalAgentToolReceiver
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`, which can be the existing local executor.

## Production Gateway Wiring

`attachCloudDeviceWebSocketRoute()` adds a real HTTP WebSocket upgrade route for outbound local agents:

```text
default path: /cloud/devices/ws
authenticate(request) -> owner identity
first message must be agent.hello
heartbeat updates device status and connection state
socket close marks the device offline
```

The route does not define a public authentication scheme by itself. The production gateway must inject an authenticator that maps the incoming request to the trusted `WorkspaceIdentity` owner. The device must not self-report the owner in `agent.hello`.

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

## Desktop MCP Tools

`registerCloudDesktopMcpTools()` registers three cloud-mode tools:

```text
connect_desktop: bind the current MCP session to one online device
list_devices: list visible Desktop/local agent devices for the authenticated owner
list_workspaces: return the selected device and a pending workspace catalog placeholder
```

`connect_desktop` is idempotent for the same session/device pairing. When more than one device is online, callers must pass `deviceId` from `list_devices`.

`list_workspaces` intentionally returns `catalogPending: true` until the Desktop/local agent reports an approved workspace catalog in a later phase.

## Local Agent Outbound Client

`LocalAgentOutboundClient` is the real Desktop/local-agent-side client skeleton:

```text
connect to the cloud WebSocket URL
send agent.hello on open
send agent.heartbeat on an interval
receive tool.call and tool.cancel
execute through LocalAgentToolReceiver
send tool.result back to the gateway
```

The socket factory is injectable so tests can run without a real network connection and Desktop can later provide its own lifecycle wrapper.

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
CloudDesktopToolService
GatewayMcpToolExecutor
```

Default behavior:

```text
Postgres database config -> Postgres stores for routing, session bindings, and device connections
Non-Postgres config -> in-memory stores for tests and local harnesses
No Desktop UI is created by the cloud runtime
Self-hosted devspace serve is unchanged
```

The production gateway server should inject `runtime.toolExecutor` into the cloud MCP server registration path, register `connect_desktop/list_devices/list_workspaces`, and attach `attachCloudDeviceWebSocketRoute()` to its HTTP server.

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

The Phase 3 and Phase 4 tests cover:

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
real HTTP WebSocket upgrade route registration, hello, heartbeat, close/offline state
local outbound client hello, heartbeat, tool.call, tool.result, and stop lifecycle
```

## Non-Goals Still Open

```text
No Desktop UI pairing screen yet
No browser-visible account/device linking flow yet
No signed production authentication policy in this module yet
No workspace catalog sync protocol yet
No cloud billing/quota/audit event stream yet
No local approval prompt UI yet
```

## Next Production Phase

The next phase should turn this wiring into a product-ready cloud entrypoint:

```text
bind the cloud MCP server process to GatewayMcpToolExecutor and cloud desktop tools
add the real gateway auth adapter for Desktop outbound connections
add Desktop-managed lifecycle around LocalAgentOutboundClient
add workspace catalog reporting from Desktop/local agent to cloud
add audit/idempotency events around connect_desktop and routed tool calls
keep self-hosted devspace serve as the local-only mode
```