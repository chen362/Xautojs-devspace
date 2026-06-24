import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { ServerConfig } from "./config.js";
import { CloudDeviceAuthorizationService, InMemoryCloudDeviceAuthorizationStore } from "./cloud-device-code-auth.js";
import { registerCloudDeviceCodeApiRoutes } from "./cloud-device-code-api.js";
import { verifyCloudGatewayDeviceToken } from "./cloud-gateway-auth.js";
import type { WorkspaceIdentity } from "./identity.js";

const owner: WorkspaceIdentity = { tenantId: "tenant_http_auth", userId: "user_http_auth" };
const tokenSecret = "device_code_http_test_secret";
const app = express();
const registered = registerCloudDeviceCodeApiRoutes(app, testConfig(), {
  service: new CloudDeviceAuthorizationService({
    store: new InMemoryCloudDeviceAuthorizationStore(),
    tokenSecret,
    verificationUri: "https://gateway.example.com/cloud/device",
    pollIntervalSeconds: 0,
    tokenTtlSeconds: 3_600,
  }),
  resolveOwner: (request) => request.header("x-test-owner") === "owner" ? owner : undefined,
});
const server = createServer(app);

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await postJson(baseUrl, "/api/cloud/device-code", {
    clientName: "Xautojs Desktop",
    deviceId: "dev_http_auth_a",
    desktopInstanceId: "desk_http_auth_a",
  });
  assert.equal(created.status, 201);
  assert.match(stringField(created.body, "deviceCode"), /^dc_/);
  assert.match(stringField(created.body, "userCode"), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(stringField(created.body, "verificationUriComplete").includes("user_code="), true);

  const pending = await postJson(baseUrl, "/api/cloud/device-code/token", {
    deviceCode: stringField(created.body, "deviceCode"),
  });
  assert.equal(pending.status, 202);
  assert.equal(errorCode(pending.body), "AUTHORIZATION_PENDING");

  const forbiddenApprove = await postJson(baseUrl, `/api/cloud/device-code/${stringField(created.body, "userCode")}/approve`, {
    deviceId: "dev_http_auth_a",
  });
  assert.equal(forbiddenApprove.status, 403);
  assert.equal(errorCode(forbiddenApprove.body), "ACCESS_DENIED");

  const approved = await postJson(baseUrl, `/api/cloud/device-code/${stringField(created.body, "userCode")}/approve`, {
    deviceId: "dev_http_auth_a",
    desktopInstanceId: "desk_http_auth_a",
  }, { "x-test-owner": "owner" });
  assert.equal(approved.status, 200);
  assert.equal(stringField(approved.body, "status"), "approved");

  const token = await postJson(baseUrl, "/api/cloud/device-code/token", {
    deviceCode: stringField(created.body, "deviceCode"),
  });
  assert.equal(token.status, 200);
  assert.equal(stringField(token.body, "tokenType"), "Bearer");
  const verified = verifyCloudGatewayDeviceToken(
    stringField(token.body, "accessToken"),
    tokenSecret,
  );
  assert.deepEqual(verified.owner, owner);
  assert.equal(verified.deviceId, "dev_http_auth_a");
  assert.equal(verified.desktopInstanceId, "desk_http_auth_a");

  const createdForDeny = await postJson(baseUrl, "/api/cloud/device-code", {});
  const denied = await postJson(
    baseUrl,
    `/api/cloud/device-code/${stringField(createdForDeny.body, "userCode")}/deny`,
    {},
    { "x-test-owner": "owner" },
  );
  assert.equal(denied.status, 200);
  assert.equal(stringField(denied.body, "status"), "denied");
  const deniedPoll = await postJson(baseUrl, "/api/cloud/device-code/token", {
    deviceCode: stringField(createdForDeny.body, "deviceCode"),
  });
  assert.equal(deniedPoll.status, 403);
  assert.equal(errorCode(deniedPoll.body), "ACCESS_DENIED");
} finally {
  await registered.close();
  server.close();
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json() as Record<string, unknown>;
  return { status: response.status, body: responseBody };
}

function stringField(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") throw new Error(`Expected string field ${field}`);
  return fieldValue;
}

function errorCode(value: Record<string, unknown>): string | undefined {
  const error = value.error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function testConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    deploymentMode: "local",
    oauth: {
      mode: "owner-token",
      ownerToken: "owner_token_for_http_test",
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 86_400,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost"],
    },
    database: {
      provider: "sqlite",
      stateDir: "/tmp/devspace-http-test",
      filePath: "/tmp/devspace-http-test/devspace.sqlite",
    },
    allowedRoots: ["/tmp"],
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "https://gateway.example.com",
    minimalTools: true,
    toolNaming: "short",
    widgets: "off",
    stateDir: "/tmp/devspace-http-test",
    worktreeRoot: "/tmp/devspace-http-test/worktrees",
    workspaceSessionTtlSeconds: null,
    workspaceSessionCleanupIntervalSeconds: 3_600,
    skillsEnabled: false,
    skillPaths: [],
    agentDir: "/tmp/devspace-http-test/agent",
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}
