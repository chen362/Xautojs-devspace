# Xautojs Cloud Agent Control Plane

Last updated: 2026-06-24

This document tracks the executable cloud-agent control plane code path. It complements `xautojs-cloud-mcp-gateway.md` and focuses on the concrete Phase 3 interfaces now present in the repository.

## Phase 3 Status

Phase 3 introduces the first real outbound-channel skeleton while keeping Desktop UI and a production WebSocket server out of scope.

Implemented files:

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
  -> GatewayMcpToolExecutor
  -> CloudRoutingStore
  -> CloudSessionBindingService
  -> WebSocketDeviceChannel
  -> outbound connected Desktop/local agent
  -> LocalAgentToolReceiver
  -> DevspaceToolExecutor on the customer machine
```

`GatewayMcpToolExecutor` remains the cloud-side execution boundary. It never imports `pi-tools`, never resolves local absolute paths, and never executes shell commands directly.

`LocalAgentToolReceiver` is the customer-machine boundary. It receives protocol `tool.call` messages and invokes the injected `DevspaceToolExecutor`, which can be the existing local executor.

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

## Device Channel Contract

`WebSocketDeviceChannel` is intentionally transport-adapter friendly. It does not import a specific `ws` implementation. A production WebSocket server only needs to register a `CloudDeviceConnection` with a `send(message)` method.

The channel owns:

```text
device connection registry
capability normalization
heartbeat lastSeenAt updates
toolCallId -> pending promise correlation
tool timeout -> TOOL_TIMEOUT
device disconnect -> AGENT_DISCONNECTED
tool.cancel forwarding
```

## Gateway Runtime Contract

`createCloudGatewayRuntime()` builds the cloud control plane pieces:

```text
CloudRoutingStore
CloudSessionBindingService
CloudDeviceChannel
GatewayMcpToolExecutor
```

Default behavior:

```text
Postgres database config -> PostgresCloudRoutingStore + PostgresCloudSessionBindingService
Non-Postgres config -> in-memory stores for tests and local harnesses
No default Desktop UI or production WebSocket HTTP route is created in this phase
```

The production gateway server should inject `runtime.toolExecutor` into the MCP server registration path and register outbound device sockets into `runtime.deviceChannel`.

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

The Phase 3 tests cover:

```text
heartbeat updates and capability normalization
cancel forwarding
tool.call -> tool.result correlation
tool timeout error mapping
GatewayMcpToolExecutor -> WebSocketDeviceChannel -> LocalAgentToolReceiver -> DevspaceToolExecutor loop
read/write/shell route completion
disconnected device mapping to AGENT_DISCONNECTED and failed toolCall status
Postgres session binding persistence and isolation errors
```

## Non-Goals In This Phase

```text
No Desktop UI changes
No real browser-visible pairing flow
No production WebSocket HTTP upgrade route yet
No cloud billing/quota/audit event stream yet
No local approval prompt UI yet
```

## Next Production Phase

The next phase should wire the transport into an actual server process:

```text
add cloud gateway HTTP/WebSocket route for device connections
parse agent.hello and register authenticated device connections
persist device connection state and heartbeats
add connect_desktop/list_devices/list_workspaces MCP tools
wire Desktop/local agent process to the channel protocol
keep self-hosted devspace serve unchanged
```
