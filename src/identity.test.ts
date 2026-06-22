import assert from "node:assert/strict";
import {
  createLocalIdentity,
  createOidcIdentity,
  identityFromAuthInfo,
  identityMatches,
  type DevSpaceAuthInfo,
} from "./identity.js";

const local = createLocalIdentity(["devspace"], "local-client");
assert.equal(local.authMode, "owner-token");
assert.equal(local.tenantId, "local");
assert.equal(local.userId, "owner");
assert.equal(local.clientId, "local-client");
assert.deepEqual(local.scopes, ["devspace"]);

const oidc = createOidcIdentity({
  issuer: "https://auth.example.com",
  subject: "user-123",
  tenantExternalId: "org-456",
  clientId: "client-789",
  scopes: ["devspace"],
});
assert.equal(oidc.authMode, "oidc");
assert.equal(oidc.tenantId, "https://auth.example.com#org-456");
assert.equal(oidc.userId, "https://auth.example.com#org-456#user-123");
assert.equal(oidc.tenantExternalId, "org-456");
assert.equal(oidc.userExternalId, "user-123");
assert.equal(oidc.clientId, "client-789");

const issuerScoped = createOidcIdentity({
  issuer: "https://single-tenant.example.com",
  subject: "user-123",
  scopes: ["devspace"],
});
assert.equal(issuerScoped.tenantId, "https://single-tenant.example.com#https://single-tenant.example.com");
assert.equal(issuerScoped.userId, "https://single-tenant.example.com#https://single-tenant.example.com#user-123");

const authWithIdentity: DevSpaceAuthInfo = {
  token: "token",
  clientId: "client",
  scopes: ["devspace"],
  expiresAt: 1,
  devspace: oidc,
};
assert.equal(
  identityFromAuthInfo(
    { deploymentMode: "production", oauth: { mode: "oidc" } },
    authWithIdentity,
  ),
  oidc,
);
assert.throws(
  () => identityFromAuthInfo({ deploymentMode: "production", oauth: { mode: "oidc" } }, undefined),
  /missing DevSpace identity context/,
);
assert.equal(
  identityFromAuthInfo(
    { deploymentMode: "local", oauth: { mode: "owner-token" } },
    { token: "token", clientId: "client", scopes: ["devspace"], expiresAt: 1 },
  ).tenantId,
  "local",
);
assert.equal(identityMatches(oidc, { tenantId: oidc.tenantId, userId: oidc.userId }), true);
assert.equal(identityMatches(oidc, { tenantId: oidc.tenantId, userId: "other" }), false);
