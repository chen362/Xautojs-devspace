import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachCloudDeviceWebSocketRoute } from "./cloud-device-websocket-route.js";
import { InMemoryCloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import { CloudDesktopToolService } from "./cloud-desktop-tool-service.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import type { CloudGatewayRuntime } from "./cloud-gateway-server.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import { WebSocketDeviceChannel } from "./websocket-device-channel.js";
import { CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION } from "./cloud-device-channel-protocol.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_prod", userId: "user_prod" };
const routingStore = new InMemoryCloudRoutingStore();
const sessionBindings = new InMemoryCloudSessionBindingService(routingStore);
const deviceChannel = new WebSocketDeviceChannel({ toolCallTimeoutMs: 500 });
const deviceConnectionStore = new InMemoryCloudDeviceConnectionStore();
const desktopToolService = new CloudDesktopToolService(sessionBindings, deviceConnectionStore);
const runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel } = {
  routingStore,
  sessionBindings,
  deviceChannel,
  deviceConnectionStore,
  desktopToolService,
  toolExecutor: new GatewayMcpToolExecutor(routingStore, deviceChannel, sessionBindings),
  close: async () => undefined,
};
const server = createServer();
const route = attachCloudDeviceWebSocketRoute({
  server,
  runtime,
  authenticate: () => ({ owner }),
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const websocket = new WebSocket(`ws://127.0.0.1:${port}${route.path}`);
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

  const workspaces = await desktopToolService.listWorkspaces(context());
  assert.equal(workspaces.deviceId, "dev_prod_a");
  assert.equal(workspaces.catalogPending, true);

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
