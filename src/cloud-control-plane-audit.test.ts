import assert from "node:assert/strict";
import { CloudRoutingError } from "./cloud-routing-contract.js";
import {
  InMemoryCloudControlPlaneAuditStore,
  stableControlPlaneFingerprint,
} from "./cloud-control-plane-audit.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_a", userId: "user_a" };
const otherOwner: WorkspaceIdentity = { tenantId: "tenant_b", userId: "user_b" };
const store = new InMemoryCloudControlPlaneAuditStore();

assert.equal(
  stableControlPlaneFingerprint({ z: 1, a: { b: 2, c: undefined } }),
  stableControlPlaneFingerprint({ a: { b: 2 }, z: 1 }),
);

const fingerprint = stableControlPlaneFingerprint({ workspaceRef: "repo-a", deviceId: "dev-a" });
const recorded = await store.recordIdempotency({
  owner,
  action: "connect_workspace",
  status: "completed",
  idempotencyKey: "idem-a",
  requestFingerprint: fingerprint,
  result: { workspaceId: "cw_a", workspaceRef: "repo-a" },
  now: "2026-06-24T00:00:00.000Z",
});
assert.equal(recorded.status, "completed");
assert.equal(recorded.idempotencyKey, "idem-a");

const replay = await store.findIdempotency<{ workspaceId: string }>(owner, "connect_workspace", "idem-a");
assert.equal(replay?.replay, true);
assert.equal(replay?.event.result?.workspaceId, "cw_a");

await assert.rejects(
  () => store.recordIdempotency({
    owner,
    action: "connect_workspace",
    status: "completed",
    idempotencyKey: "idem-a",
    requestFingerprint: stableControlPlaneFingerprint({ workspaceRef: "repo-b", deviceId: "dev-a" }),
    result: { workspaceId: "cw_b", workspaceRef: "repo-b" },
  }),
  (error) => error instanceof CloudRoutingError && error.code === "TOOL_CALL_CONFLICT",
);

await store.recordEvent({
  owner: otherOwner,
  action: "device_code.poll",
  status: "failed",
  errorCode: "AUTHORIZATION_PENDING",
});
const ownerEvents = await store.listEvents?.(owner);
assert.equal(ownerEvents?.length, 1);
assert.equal(ownerEvents?.[0]?.owner?.tenantId, "tenant_a");
