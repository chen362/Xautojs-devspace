import assert from "node:assert/strict";
import {
  CloudRoutingError,
  type CloudRoutingErrorCode,
} from "./cloud-routing-contract.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_a", userId: "user_a" };
const otherOwner: WorkspaceIdentity = { tenantId: "tenant_a", userId: "user_b" };
const store = new InMemoryCloudRoutingStore();

const device = await store.registerDevice({
  owner,
  deviceId: "dev_a",
  label: "Abba MacBook Pro",
  capabilities: ["shell", "mcp-tools", "shell"],
  now: "2026-06-24T00:00:00.000Z",
});
assert.equal(device.deviceId, "dev_a");
assert.equal(device.status, "online");
assert.deepEqual(device.capabilities, ["mcp-tools", "shell"]);

device.capabilities.push("mutated");
assert.deepEqual((await store.getDevice(owner, "dev_a"))?.capabilities, ["mcp-tools", "shell"]);

const workspace = await store.bindWorkspaceRoute({
  owner,
  deviceId: "dev_a",
  workspaceId: "mcp_ws_a",
  workspaceRef: "wsroot_xautojs",
  mcpSessionId: "mcp_session_a",
  conversationSessionId: "conv_a",
  now: "2026-06-24T00:00:01.000Z",
});
assert.equal(workspace.workspaceId, "mcp_ws_a");
assert.equal(workspace.deviceId, "dev_a");
assert.equal(workspace.mcpSessionId, "mcp_session_a");
assert.equal(workspace.conversationSessionId, "conv_a");

const resolved = await store.resolveWorkspaceRoute({
  owner,
  workspaceId: "mcp_ws_a",
  mcpSessionId: "mcp_session_a",
  conversationSessionId: "conv_a",
  toolCallId: "tc_read_1",
  tool: "read_file",
  now: "2026-06-24T00:00:02.000Z",
  deadlineAt: "2026-06-24T00:01:02.000Z",
});
assert.equal(resolved.device.deviceId, "dev_a");
assert.equal(resolved.workspace.lastRoutedAt, "2026-06-24T00:00:02.000Z");
assert.equal(resolved.toolCall?.toolCallId, "tc_read_1");
assert.equal(resolved.toolCall?.status, "routed");
assert.equal(resolved.toolCall?.tool, "read_file");
assert.equal(resolved.toolCall?.deadlineAt, "2026-06-24T00:01:02.000Z");

const repeated = await store.resolveWorkspaceRoute({
  owner,
  workspaceId: "mcp_ws_a",
  mcpSessionId: "mcp_session_a",
  conversationSessionId: "conv_a",
  toolCallId: "tc_read_1",
  tool: "read_file",
  now: "2026-06-24T00:00:03.000Z",
});
assert.equal(repeated.toolCall?.createdAt, resolved.toolCall?.createdAt);
assert.equal(repeated.toolCall?.lastSeenAt, "2026-06-24T00:00:03.000Z");

const completed = await store.completeToolCallRoute({
  owner,
  toolCallId: "tc_read_1",
  status: "completed",
  now: "2026-06-24T00:00:04.000Z",
});
assert.equal(completed?.status, "completed");
assert.equal(completed?.completedAt, "2026-06-24T00:00:04.000Z");

await assertRoutingError(
  () => store.bindWorkspaceRoute({
    owner,
    deviceId: "dev_a",
    workspaceId: "mcp_ws_a",
    mcpSessionId: "mcp_session_b",
    conversationSessionId: "conv_b",
  }),
  "WORKSPACE_FORBIDDEN",
);

await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_a",
    mcpSessionId: "mcp_session_b",
    conversationSessionId: "conv_a",
  }),
  "WORKSPACE_FORBIDDEN",
);

await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_a",
    mcpSessionId: "mcp_session_a",
    conversationSessionId: "conv_b",
  }),
  "WORKSPACE_FORBIDDEN",
);

await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_missing",
    mcpSessionId: "mcp_session_a",
    conversationSessionId: "conv_a",
  }),
  "WORKSPACE_NOT_FOUND",
);

await assertRoutingError(
  () => store.bindWorkspaceRoute({
    owner: otherOwner,
    deviceId: "dev_a",
    workspaceId: "mcp_ws_other_owner",
    mcpSessionId: "mcp_session_a",
  }),
  "DEVICE_NOT_FOUND",
);

await store.registerDevice({
  owner,
  deviceId: "dev_b",
  capabilities: ["mcp-tools"],
  now: "2026-06-24T00:00:05.000Z",
});
await store.bindWorkspaceRoute({
  owner,
  deviceId: "dev_b",
  workspaceId: "mcp_ws_b",
  mcpSessionId: "mcp_session_a",
  conversationSessionId: "conv_a",
  now: "2026-06-24T00:00:06.000Z",
});
await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_b",
    mcpSessionId: "mcp_session_a",
    conversationSessionId: "conv_a",
    toolCallId: "tc_read_1",
    tool: "read_file",
  }),
  "TOOL_CALL_CONFLICT",
);

await store.setDeviceStatus({
  owner,
  deviceId: "dev_a",
  status: "offline",
  now: "2026-06-24T00:00:07.000Z",
});
await assertRoutingError(
  () => store.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_a",
    mcpSessionId: "mcp_session_a",
    conversationSessionId: "conv_a",
    toolCallId: "tc_offline_1",
    tool: "list_directory",
  }),
  "DEVICE_OFFLINE",
  true,
);

const expiringStore = new InMemoryCloudRoutingStore();
await expiringStore.registerDevice({ owner, deviceId: "dev_expiring" });
await expiringStore.bindWorkspaceRoute({
  owner,
  deviceId: "dev_expiring",
  workspaceId: "mcp_ws_expiring",
  mcpSessionId: "mcp_session_expiring",
  expiresAt: "2026-06-24T00:00:00.000Z",
  now: "2026-06-23T23:59:59.000Z",
});
await assertRoutingError(
  () => expiringStore.resolveWorkspaceRoute({
    owner,
    workspaceId: "mcp_ws_expiring",
    mcpSessionId: "mcp_session_expiring",
    now: "2026-06-24T00:00:00.000Z",
  }),
  "SESSION_EXPIRED",
);

async function assertRoutingError(
  action: () => Promise<unknown>,
  code: CloudRoutingErrorCode,
  retryable = false,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof CloudRoutingError &&
      error.code === code &&
      error.retryable === retryable,
  );
}
