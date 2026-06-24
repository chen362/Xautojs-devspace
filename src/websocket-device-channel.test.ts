import assert from "node:assert/strict";
import { createCloudDeviceToolCall } from "./cloud-device-channel.js";
import {
  CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  createCloudDeviceToolResultMessage,
  type CloudDeviceGatewayMessage,
} from "./cloud-device-channel-protocol.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  WebSocketDeviceChannel,
  type CloudDeviceConnection,
} from "./websocket-device-channel.js";

class RecordingConnection implements CloudDeviceConnection {
  readonly sent: CloudDeviceGatewayMessage[] = [];

  send(message: CloudDeviceGatewayMessage): void {
    this.sent.push(message);
  }
}

const owner: WorkspaceIdentity = { tenantId: "tenant_ws", userId: "user_ws" };
const connection = new RecordingConnection();
const channel = new WebSocketDeviceChannel({ toolCallTimeoutMs: 5 });

const registered = channel.registerConnection({
  deviceId: "dev_ws_a",
  connection,
  capabilities: ["shell", "mcp-tools", "shell"],
  now: "2026-06-24T00:00:00.000Z",
});
assert.equal(registered.deviceId, "dev_ws_a");
assert.deepEqual(registered.capabilities, ["mcp-tools", "shell"]);

channel.handleDeviceMessage({
  type: "agent.heartbeat",
  protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  deviceId: "dev_ws_a",
  connectionId: registered.connectionId,
  time: "2026-06-24T00:00:01.000Z",
});
assert.equal(channel.getConnection("dev_ws_a")?.lastSeenAt, "2026-06-24T00:00:01.000Z");

await channel.cancelToolCall({
  deviceId: "dev_ws_a",
  toolCallId: "tc_ws_cancel",
  reason: "user_cancelled",
});
const cancelMessage = connection.sent[0];
assert.equal(cancelMessage?.type, "tool.cancel");
if (!cancelMessage || cancelMessage.type !== "tool.cancel") throw new Error("Expected tool.cancel message");
assert.equal(cancelMessage.reason, "user_cancelled");

const resultPromise = channel.sendToolCall(createCloudDeviceToolCall({
  deviceId: "dev_ws_a",
  toolCallId: "tc_ws_read",
  tool: "read_file",
  context: {
    owner,
    mcpSessionId: "mcp_ws_a",
    conversationSessionId: "conv_ws_a",
  },
  workspaceId: "mcp_ws_a",
  input: { path: "README.md" },
}));
const callMessage = connection.sent[1];
assert.equal(callMessage?.type, "tool.call");
if (!callMessage || callMessage.type !== "tool.call") throw new Error("Expected tool.call message");
assert.equal(callMessage.context.deviceId, "dev_ws_a");
assert.equal(callMessage.context.toolCallId, "tc_ws_read");

channel.handleDeviceMessage(createCloudDeviceToolResultMessage({
  deviceId: "dev_ws_a",
  toolCallId: "tc_ws_read",
  result: { isError: false, content: [{ type: "text", text: "ok" }] },
}));
const result = await resultPromise;
assert.equal(result.ok, true);
if (!result.ok) throw new Error("Expected successful tool result");
assert.deepEqual(result.result, { isError: false, content: [{ type: "text", text: "ok" }] });

const timeoutResult = await channel.sendToolCall(createCloudDeviceToolCall({
  deviceId: "dev_ws_a",
  toolCallId: "tc_ws_timeout",
  tool: "read_file",
  context: {
    owner,
    mcpSessionId: "mcp_ws_a",
    conversationSessionId: "conv_ws_a",
  },
  workspaceId: "mcp_ws_a",
  input: { path: "README.md" },
}));
assert.equal(timeoutResult.ok, false);
if (timeoutResult.ok) throw new Error("Expected timeout error");
assert.equal(timeoutResult.error.code, "TOOL_TIMEOUT");
assert.equal(timeoutResult.error.retryable, true);

await channel.markDeviceOffline({ deviceId: "dev_ws_a", reason: "test_offline" });
assert.equal(channel.getConnection("dev_ws_a"), undefined);
