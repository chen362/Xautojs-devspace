import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  CloudGatewayAuthError,
  createSignedCloudDeviceWebSocketAuthenticator,
  issueCloudGatewayDeviceToken,
  verifyCloudGatewayDeviceToken,
} from "./cloud-gateway-auth.js";

const secret = "test_secret_that_is_long_enough";
const token = issueCloudGatewayDeviceToken({
  tenantId: "tenant_auth",
  userId: "user_auth",
  deviceId: "dev_auth_a",
  desktopInstanceId: "desk_auth_a",
  issuedAt: "2026-06-24T00:00:00.000Z",
  expiresAt: "2026-06-24T00:10:00.000Z",
}, secret);

const verified = verifyCloudGatewayDeviceToken(token, secret, "2026-06-24T00:05:00.000Z");
assert.deepEqual(verified.owner, { tenantId: "tenant_auth", userId: "user_auth" });
assert.equal(verified.deviceId, "dev_auth_a");
assert.equal(verified.desktopInstanceId, "desk_auth_a");

const authenticator = createSignedCloudDeviceWebSocketAuthenticator({
  secret,
  now: () => "2026-06-24T00:05:00.000Z",
});
const auth = await authenticator({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage);
assert.equal(auth?.owner.tenantId, "tenant_auth");
assert.equal(auth?.deviceId, "dev_auth_a");
assert.equal(await authenticator({ headers: {} } as IncomingMessage), undefined);

await assert.rejects(
  () => Promise.resolve(verifyCloudGatewayDeviceToken(`${token}x`, secret, "2026-06-24T00:05:00.000Z")),
  (error: unknown) => error instanceof CloudGatewayAuthError && error.code === "AUTH_INVALID",
);

await assert.rejects(
  () => Promise.resolve(verifyCloudGatewayDeviceToken(token, secret, "2026-06-24T00:10:00.000Z")),
  (error: unknown) => error instanceof CloudGatewayAuthError && error.code === "AUTH_EXPIRED",
);

const queryAuthenticator = createSignedCloudDeviceWebSocketAuthenticator({
  secret,
  now: () => "2026-06-24T00:05:00.000Z",
  allowQueryToken: true,
});
const queryAuth = await queryAuthenticator({
  url: `/cloud/devices/ws?access_token=${encodeURIComponent(token)}`,
  headers: {},
} as IncomingMessage);
assert.equal(queryAuth?.owner.userId, "user_auth");
