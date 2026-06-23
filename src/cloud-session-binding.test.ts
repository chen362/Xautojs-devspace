import assert from "node:assert/strict";
import {
  CloudRoutingError,
  type CloudRoutingErrorCode,
} from "./cloud-routing-contract.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_binding", userId: "user_binding" };
const store = new InMemoryCloudRoutingStore();
const bindings = new InMemoryCloudSessionBindingService(store);

await assertRoutingError(
  () => bindings.resolveDevice({
    owner,
    mcpSessionId: "mcp_unpaired",
    conversationSessionId: "conv_unpaired",
  }),
  "PAIRING_REQUIRED",
);

await store.registerDevice({
  owner,
  deviceId: "dev_binding_a",
  label: "Binding Device A",
  capabilities: ["mcp-tools"],
  now: "2026-06-24T00:00:00.000Z",
});

const binding = await bindings.resolveDevice({
  owner,
  mcpSessionId: "mcp_binding_a",
  conversationSessionId: "conv_binding_a",
  deviceId: "dev_binding_a",
  now: "2026-06-24T00:00:01.000Z",
});
assert.equal(binding.deviceId, "dev_binding_a");
assert.equal(binding.mcpSessionId, "mcp_binding_a");
assert.equal(binding.conversationSessionId, "conv_binding_a");

const resolvedAgain = await bindings.resolveDevice({
  owner,
  mcpSessionId: "mcp_binding_a",
  conversationSessionId: "conv_binding_a",
  now: "2026-06-24T00:00:02.000Z",
});
assert.equal(resolvedAgain.deviceId, "dev_binding_a");
assert.equal(resolvedAgain.lastSeenAt, "2026-06-24T00:00:02.000Z");

await assertRoutingError(
  () => bindings.resolveDevice({
    owner,
    mcpSessionId: "mcp_binding_a",
    conversationSessionId: "conv_binding_b",
    now: "2026-06-24T00:00:03.000Z",
  }),
  "WORKSPACE_FORBIDDEN",
);

await store.registerDevice({ owner, deviceId: "dev_binding_b" });
await assertRoutingError(
  () => bindings.resolveDevice({
    owner,
    mcpSessionId: "mcp_binding_a",
    conversationSessionId: "conv_binding_a",
    deviceId: "dev_binding_b",
    now: "2026-06-24T00:00:04.000Z",
  }),
  "DEVICE_FORBIDDEN",
);

await store.setDeviceStatus({ owner, deviceId: "dev_binding_a", status: "offline" });
await assertRoutingError(
  () => bindings.resolveDevice({
    owner,
    mcpSessionId: "mcp_binding_a",
    conversationSessionId: "conv_binding_a",
    now: "2026-06-24T00:00:05.000Z",
  }),
  "DEVICE_OFFLINE",
  true,
);

await store.registerDevice({
  owner,
  deviceId: "dev_binding_expiring",
  now: "2026-06-24T00:00:00.000Z",
  expiresAt: "2026-06-24T00:00:10.000Z",
});
await bindings.bindDevice({
  owner,
  mcpSessionId: "mcp_binding_expiring",
  conversationSessionId: "conv_binding_expiring",
  deviceId: "dev_binding_expiring",
  now: "2026-06-24T00:00:01.000Z",
  expiresAt: "2026-06-24T00:10:00.000Z",
});
await assertRoutingError(
  () => bindings.resolveDevice({
    owner,
    mcpSessionId: "mcp_binding_expiring",
    conversationSessionId: "conv_binding_expiring",
    now: "2026-06-24T00:00:11.000Z",
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
