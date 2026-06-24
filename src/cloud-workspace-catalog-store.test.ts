import assert from "node:assert/strict";
import { InMemoryCloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_catalog", userId: "user_catalog" };
const otherOwner: WorkspaceIdentity = { tenantId: "tenant_catalog", userId: "user_catalog_other" };
const store = new InMemoryCloudWorkspaceCatalogStore();

const recorded = await store.recordCatalog({
  owner,
  deviceId: "dev_catalog_a",
  catalogVersion: "v1",
  now: "2026-06-24T00:00:00.000Z",
  workspaces: [
    {
      workspaceRef: "workspace_b",
      displayName: "Beta",
      rootLabel: "~/beta",
      capabilities: ["write", "read", "read"],
    },
    {
      workspaceRef: "workspace_a",
      displayName: "Alpha",
      rootLabel: "~/alpha",
      capabilities: ["read"],
    },
  ],
});
assert.equal(recorded.length, 2);
assert.deepEqual(recorded[0]?.capabilities, ["read", "write"]);

const listed = await store.listWorkspaces({ owner, deviceId: "dev_catalog_a" });
assert.deepEqual(listed.map((workspace) => workspace.workspaceRef), ["workspace_a", "workspace_b"]);
assert.equal(listed[0]?.catalogVersion, "v1");
assert.equal(listed[0]?.lastSeenAt, "2026-06-24T00:00:00.000Z");

await store.recordCatalog({
  owner: otherOwner,
  deviceId: "dev_catalog_a",
  now: "2026-06-24T00:00:01.000Z",
  workspaces: [{ workspaceRef: "workspace_other", displayName: "Other", rootLabel: "~/other", capabilities: [] }],
});
assert.deepEqual(
  (await store.listWorkspaces({ owner, deviceId: "dev_catalog_a" })).map((workspace) => workspace.workspaceRef),
  ["workspace_a", "workspace_b"],
);

await store.recordCatalog({
  owner,
  deviceId: "dev_catalog_a",
  catalogVersion: "v2",
  now: "2026-06-24T00:00:02.000Z",
  workspaces: [{ workspaceRef: "workspace_c", displayName: "Gamma", rootLabel: "~/gamma", capabilities: ["read"] }],
});
assert.deepEqual(
  (await store.listWorkspaces({ owner, deviceId: "dev_catalog_a" })).map((workspace) => workspace.workspaceRef),
  ["workspace_c"],
);

await store.clearDeviceCatalog?.(owner, "dev_catalog_a");
assert.deepEqual(await store.listWorkspaces({ owner, deviceId: "dev_catalog_a" }), []);
