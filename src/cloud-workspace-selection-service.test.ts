import assert from "node:assert/strict";
import { CloudRoutingError } from "./cloud-routing-contract.js";
import { InMemoryCloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import { InMemoryCloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import { CloudWorkspaceSelectionService } from "./cloud-workspace-selection-service.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_ws", userId: "user_ws" };
const context: DevspaceToolExecutionContext = {
  owner,
  mcpSessionId: "mcp_ws_a",
  conversationSessionId: "conv_ws_a",
};
const routingStore = new InMemoryCloudRoutingStore();
const sessionBindings = new InMemoryCloudSessionBindingService(routingStore);
const catalogStore = new InMemoryCloudWorkspaceCatalogStore();
const auditStore = new InMemoryCloudControlPlaneAuditStore();
const service = new CloudWorkspaceSelectionService(
  sessionBindings,
  routingStore,
  catalogStore,
  auditStore,
);

await routingStore.registerDevice({
  owner,
  deviceId: "dev_ws_a",
  capabilities: ["shell", "mcp-tools"],
  status: "online",
  now: "2026-06-24T00:00:00.000Z",
});
await sessionBindings.bindDevice({
  owner,
  mcpSessionId: context.mcpSessionId,
  conversationSessionId: context.conversationSessionId,
  deviceId: "dev_ws_a",
  now: "2026-06-24T00:00:01.000Z",
});
await catalogStore.recordCatalog({
  owner,
  deviceId: "dev_ws_a",
  catalogVersion: "catalog_a",
  now: "2026-06-24T00:00:02.000Z",
  workspaces: [{
    workspaceRef: "repo-a",
    displayName: "Alpha Repo",
    rootLabel: "~/repo-a",
    capabilities: ["write", "read", "read"],
  }],
});

const connected = await service.connectWorkspace(context, {
  workspaceRef: "repo-a",
  idempotencyKey: "idem-repo-a",
});
assert.equal(connected.status, "connected");
assert.match(connected.workspaceId, /^cw_/);
assert.equal(connected.deviceId, "dev_ws_a");
assert.equal(connected.workspaceRef, "repo-a");
assert.deepEqual(connected.capabilities, ["read", "write"]);

const resolved = await routingStore.resolveWorkspaceRoute({
  owner,
  mcpSessionId: context.mcpSessionId,
  conversationSessionId: context.conversationSessionId,
  workspaceId: connected.workspaceId,
  toolCallId: "tool_ws_a",
});
assert.equal(resolved.workspace.workspaceRef, "repo-a");
assert.equal(resolved.device.deviceId, "dev_ws_a");
assert.equal(resolved.toolCall?.toolCallId, "tool_ws_a");

const replay = await service.connectWorkspace(context, {
  workspaceRef: "repo-a",
  idempotencyKey: "idem-repo-a",
});
assert.equal(replay.idempotentReplay, true);
assert.equal(replay.workspaceId, connected.workspaceId);

await catalogStore.recordCatalog({
  owner,
  deviceId: "dev_ws_a",
  catalogVersion: "catalog_b",
  now: "2026-06-24T00:00:03.000Z",
  workspaces: [{
    workspaceRef: "repo-b",
    displayName: "Beta Repo",
    rootLabel: "~/repo-b",
    capabilities: ["read"],
  }],
});
await assert.rejects(
  () => service.connectWorkspace(context, { workspaceRef: "repo-b", idempotencyKey: "idem-repo-a" }),
  (error) => error instanceof CloudRoutingError && error.code === "TOOL_CALL_CONFLICT",
);
await assert.rejects(
  () => service.connectWorkspace(context, { workspaceRef: "missing-repo" }),
  (error) => error instanceof CloudRoutingError && error.code === "WORKSPACE_NOT_FOUND",
);

const events = await auditStore.listEvents?.(owner);
assert.equal(events?.some((event) => event.action === "connect_workspace" && event.idempotencyKey === "idem-repo-a"), true);
