import assert from "node:assert/strict";
import {
  CloudDeviceAuthorizationError,
  CloudDeviceAuthorizationService,
  InMemoryCloudDeviceAuthorizationStore,
} from "./cloud-device-code-auth.js";
import { verifyCloudGatewayDeviceToken } from "./cloud-gateway-auth.js";
import { InMemoryCloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_auth", userId: "user_auth" };
const tokenSecret = "device_code_test_secret";
const auditStore = new InMemoryCloudControlPlaneAuditStore();
const service = new CloudDeviceAuthorizationService({
  store: new InMemoryCloudDeviceAuthorizationStore(),
  auditStore,
  tokenSecret,
  verificationUri: "https://gateway.example.com/device",
  tokenTtlSeconds: 3_600,
  pollIntervalSeconds: 5,
});

const created = await service.create({
  clientName: "Xautojs Desktop",
  deviceId: "dev_auth_a",
  desktopInstanceId: "desk_auth_a",
  now: "2026-06-24T00:00:00.000Z",
  expiresInSeconds: 60,
});
assert.equal(created.verificationUri, "https://gateway.example.com/device");
assert.match(created.deviceCode, /^dc_/);
assert.match(created.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

await assert.rejects(
  () => service.poll({ deviceCode: created.deviceCode, now: "2026-06-24T00:00:01.000Z" }),
  (error) => error instanceof CloudDeviceAuthorizationError
    && error.code === "AUTHORIZATION_PENDING"
    && error.retryable,
);

await assert.rejects(
  () => service.poll({ deviceCode: created.deviceCode, now: "2026-06-24T00:00:03.000Z" }),
  (error) => error instanceof CloudDeviceAuthorizationError
    && error.code === "SLOW_DOWN"
    && error.retryable,
);

await service.approve({
  userCode: created.userCode,
  owner,
  now: "2026-06-24T00:00:05.000Z",
});
const token = await service.poll({ deviceCode: created.deviceCode, now: "2026-06-24T00:00:10.000Z" });
assert.equal(token.tokenType, "Bearer");
assert.equal(token.deviceId, "dev_auth_a");
assert.equal(token.desktopInstanceId, "desk_auth_a");
assert.equal(token.expiresAt, "2026-06-24T01:00:10.000Z");

const verified = verifyCloudGatewayDeviceToken(
  token.accessToken,
  tokenSecret,
  "2026-06-24T00:00:11.000Z",
);
assert.deepEqual(verified.owner, owner);
assert.equal(verified.deviceId, "dev_auth_a");
assert.equal(verified.desktopInstanceId, "desk_auth_a");

const denied = await service.create({ now: "2026-06-24T00:01:00.000Z", expiresInSeconds: 60 });
await service.deny(denied.userCode, "2026-06-24T00:01:05.000Z");
await assert.rejects(
  () => service.poll({ deviceCode: denied.deviceCode, now: "2026-06-24T00:01:10.000Z" }),
  (error) => error instanceof CloudDeviceAuthorizationError && error.code === "ACCESS_DENIED",
);

const expired = await service.create({ now: "2026-06-24T00:02:00.000Z", expiresInSeconds: 1 });
await assert.rejects(
  () => service.poll({ deviceCode: expired.deviceCode, now: "2026-06-24T00:02:02.000Z" }),
  (error) => error instanceof CloudDeviceAuthorizationError && error.code === "EXPIRED_TOKEN",
);

const ownerEvents = await auditStore.listEvents?.(owner);
assert.equal(ownerEvents?.some((event) => event.action === "device_code.approve" && event.status === "completed"), true);
assert.equal(ownerEvents?.some((event) => event.action === "device_code.poll" && event.status === "completed"), true);
