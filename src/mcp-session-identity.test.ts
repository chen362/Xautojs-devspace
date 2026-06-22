import assert from "node:assert/strict";
import { createOidcIdentity } from "./identity.js";
import {
  assertMcpSessionIdentity,
  McpSessionIdentityMismatchError,
} from "./mcp-session-identity.js";

const alice = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-a",
  subject: "alice",
  scopes: ["devspace"],
});
const alsoAlice = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-a",
  subject: "alice",
  scopes: ["devspace"],
});
const bob = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-a",
  subject: "bob",
  scopes: ["devspace"],
});
const otherTenantAlice = createOidcIdentity({
  issuer: "https://auth.example.com",
  tenantExternalId: "tenant-b",
  subject: "alice",
  scopes: ["devspace"],
});

assert.doesNotThrow(() =>
  assertMcpSessionIdentity({
    sessionId: "session-a",
    sessionOwner: alice,
    requestOwner: alsoAlice,
  }),
);

assert.throws(
  () =>
    assertMcpSessionIdentity({
      sessionId: "session-a",
      sessionOwner: alice,
      requestOwner: bob,
    }),
  McpSessionIdentityMismatchError,
);

assert.throws(
  () =>
    assertMcpSessionIdentity({
      sessionId: "session-a",
      sessionOwner: alice,
      requestOwner: otherTenantAlice,
    }),
  McpSessionIdentityMismatchError,
);
