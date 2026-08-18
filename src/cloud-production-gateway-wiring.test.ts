import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createSignedCloudDeviceWebSocketAuthenticator, issueCloudGatewayDeviceToken } from "./cloud-gateway-auth.js";
import { attachCloudDeviceWebSocketRoute } from "./cloud-device-websocket-route.js";
import { InMemoryCloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import { InMemoryCloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import { CloudDesktopToolService } from "./cloud-desktop-tool-service.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import { InMemoryCloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import { CloudWorkspaceSelectionService } from "./cloud-workspace-selection-service.js";
import type { CloudGatewayRuntime } from "./cloud-gateway-server.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import { WebSocketDeviceChannel } from "./websocket-device-channel.js";
import { CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION } from "./cloud-device-channel-protocol.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_prod", userId: "user_prod" };
const authSecret = "prod_test_secret";
const deviceToken = issueCloudGatewayDeviceToken({
  tenantId: owner.tenantId,
  userId: owner.userId,
  deviceId: "dev_prod_a",
  desktopInstanceId: "desk_prod_a",
  issuedAt: "2026-06-24T00:00:00.000Z",
}, authSecret);
const routingStore = new InMemoryCloudRoutingStore();
const sessionBindings = new InMemoryCloudSessionBindingService(routingStore);
const deviceChannel = new WebSocketDeviceChannel({ toolCallTimeoutMs: 500 });
const deviceConnectionStore = new InMemoryCloudDeviceConnectionStore();
const workspaceCatalogStore = new InMemoryCloudWorkspaceCatalogStore();
const auditStore = new InMemoryCloudControlPlaneAuditStore();
const workspaceSelectionService = new CloudWorkspaceSelectionService(
  sessionBindings,
  routingStore,
  workspaceCatalogStore,
  auditStore,
);
const desktopToolService = new CloudDesktopToolService(
  sessionBindings,
  deviceConnectionStore,
  workspaceCatalogStore,
  workspaceSelectionService,
);
const runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel } = {
  routingStore,
  sessionBindings,
  deviceChannel,
  deviceConnectionStore,
  workspaceCatalogStore,
  auditStore,
  workspaceSelectionService,
  desktopToolService,
  toolExecutor: new GatewayMcpToolExecutor(routingStore, deviceChannel, sessionBindings),
  close: async () => undefined,
};
const server = createServer();
const route = attachCloudDeviceWebSocketRoute({
  server,
  runtime,
  authenticate: createSignedCloudDeviceWebSocketAuthenticator({
    secret: authSecret,
    now: () => "2026-06-24T00:05:00.000Z",
  }),
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const websocket = new WebSocket(`ws://127.0.0.1:${port}${route.path}`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  await once(websocket, "open");

  websocket.send(JSON.stringify({
    type: "agent.hello",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: "dev_prod_a",
    desktopInstanceId: "desk_prod_a",
    agentVersion: "1.2.3",
    capabilities: ["shell", "mcp-tools", "shell"],
    time: "2026-06-24T00:00:00.000Z",
  }));
  await waitFor(async () => (await deviceConnectionStore.getConnection(owner, "dev_prod_a"))?.status === "online");

  const listed = await desktopToolService.listDevices(context());
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0]?.deviceId, "dev_prod_a");
  assert.deepEqual(listed.devices[0]?.capabilities, ["mcp-tools", "shell"]);

  const connected = await desktopToolService.connectDesktop(context(), { deviceId: "dev_prod_a" });
  assert.equal(connected.status, "connected");
  assert.equal(connected.deviceId, "dev_prod_a");

  websocket.send(JSON.stringify({
    type: "workspace.catalog",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: "dev_prod_a",
    catalogVersion: "catalog_v1",
    time: "2026-06-24T00:00:02.000Z",
    workspaces: [{
      workspaceRef: "workspace_prod_a",
      displayName: "Production Workspace",
      rootLabel: "~/projects/prod",
      capabilities: ["read", "write", "read"],
    }],
  }));
  await waitFor(async () =>
    (await workspaceCatalogStore.listWorkspaces({ owner, deviceId: "dev_prod_a" })).length === 1,
  );

  const workspaces = await desktopToolService.listWorkspaces(context());
  assert.equal(workspaces.deviceId, "dev_prod_a");
  assert.equal(workspaces.catalogPending, false);
  assert.equal(workspaces.workspaces[0]?.workspaceRef, "workspace_prod_a");
  assert.deepEqual(workspaces.workspaces[0]?.capabilities, ["read", "write"]);

  const workspaceConnection = await desktopToolService.connectWorkspace(context(), {
    workspaceRef: "workspace_prod_a",
    idempotencyKey: "idem_workspace_prod_a",
  });
  assert.equal(workspaceConnection.status, "connected");
  assert.equal(workspaceConnection.deviceId, "dev_prod_a");
  assert.equal(workspaceConnection.workspaceRef, "workspace_prod_a");
  assert.match(workspaceConnection.workspaceId, /^cw_/);

  const routeResolution = await routingStore.resolveWorkspaceRoute({
    owner,
    mcpSessionId: "mcp_prod_a",
    conversationSessionId: "conv_prod_a",
    workspaceId: workspaceConnection.workspaceId,
    toolCallId: "tool_prod_a",
  });
  assert.equal(routeResolution.workspace.workspaceRef, "workspace_prod_a");
  assert.equal(routeResolution.toolCall?.toolCallId, "tool_prod_a");

  websocket.send(JSON.stringify({
    type: "agent.heartbeat",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: "dev_prod_a",
    time: "2026-06-24T00:00:05.000Z",
  }));
  await waitFor(async () =>
    (await deviceConnectionStore.getConnection(owner, "dev_prod_a"))?.lastHeartbeatAt === "2026-06-24T00:00:05.000Z",
  );

  websocket.close();
  await waitFor(async () => (await deviceConnectionStore.getConnection(owner, "dev_prod_a"))?.status === "offline");
  assert.equal((await routingStore.getDevice(owner, "dev_prod_a"))?.status, "offline");
} finally {
  route.close();
  server.close();
}

function context(): DevspaceToolExecutionContext {
  return {
    owner,
    mcpSessionId: "mcp_prod_a",
    conversationSessionId: "conv_prod_a",
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
