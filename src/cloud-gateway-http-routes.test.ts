import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import type { ServerConfig } from "./config.js";
import type { CloudGatewayRuntime } from "./cloud-gateway-server.js";
import { createCloudGatewayRuntime, registerCloudGatewayHttpRoutes } from "./cloud-gateway-server.js";
import { verifyCloudGatewayDeviceToken } from "./cloud-gateway-auth.js";
import { LOCAL_WORKSPACE_IDENTITY, type WorkspaceIdentity } from "./identity.js";

const tokenSecret = "gateway_http_routes_test_secret";

await withGateway(testConfig("default"), {}, async (baseUrl, runtime, config) => {
  const created = await postJson(baseUrl, "/api/cloud/device-code", {
    clientName: "Xautojs Desktop",
    deviceId: "dev_gateway_http_a",
    desktopInstanceId: "desk_gateway_http_a",
  });
  assert.equal(created.status, 201);

  const deniedApprove = await postJson(
    baseUrl,
    `/api/cloud/device-code/${stringField(created.body, "userCode")}/approve`,
    { deviceId: "dev_gateway_http_a" },
  );
  assert.equal(deniedApprove.status, 403);
  assert.equal(errorCode(deniedApprove.body), "ACCESS_DENIED");

  const approved = await postJson(
    baseUrl,
    `/api/cloud/device-code/${stringField(created.body, "userCode")}/approve`,
    {
      deviceId: "dev_gateway_http_a",
      desktopInstanceId: "desk_gateway_http_a",
    },
    { authorization: `Bearer ${config.oauth.ownerToken}` },
  );
  assert.equal(approved.status, 200);
  assert.equal(stringField(approved.body, "status"), "approved");

  const token = await postJson(baseUrl, "/api/cloud/device-code/token", {
    deviceCode: stringField(created.body, "deviceCode"),
  });
  assert.equal(token.status, 200);
  const verified = verifyCloudGatewayDeviceToken(stringField(token.body, "accessToken"), tokenSecret);
  assert.deepEqual(verified.owner, LOCAL_WORKSPACE_IDENTITY);
  assert.equal(verified.deviceId, "dev_gateway_http_a");
  assert.equal(verified.desktopInstanceId, "desk_gateway_http_a");

  const events = await runtime.auditStore.listEvents?.();
  if (!events) throw new Error("Expected gateway runtime audit store to support listEvents().");
  assert.equal(events.filter((event) => event.action === "device_code.create").length, 1);
  assert.equal(events.filter((event) => event.action === "device_code.approve" && event.status === "completed").length, 1);
  assert.equal(events.filter((event) => event.action === "device_code.poll" && event.status === "completed").length, 1);
});

await withGateway(testConfig("custom"), {
  resolveOwner: (request) => {
    const tenantId = request.header("x-devspace-tenant-id")?.trim();
    const userId = request.header("x-devspace-user-id")?.trim();
    return tenantId && userId ? { tenantId, userId } : undefined;
  },
}, async (baseUrl) => {
  const created = await postJson(baseUrl, "/api/cloud/device-code", {
    deviceId: "dev_gateway_http_b",
  });
  assert.equal(created.status, 201);

  const approved = await postJson(
    baseUrl,
    `/api/cloud/device-code/${stringField(created.body, "userCode")}/approve`,
    { desktopInstanceId: "desk_gateway_http_b" },
    {
      "x-devspace-tenant-id": "tenant_gateway_http",
      "x-devspace-user-id": "user_gateway_http",
    },
  );
  assert.equal(approved.status, 200);

  const token = await postJson(baseUrl, "/api/cloud/device-code/token", {
    deviceCode: stringField(created.body, "deviceCode"),
  });
  assert.equal(token.status, 200);
  const verified = verifyCloudGatewayDeviceToken(stringField(token.body, "accessToken"), tokenSecret);
  assert.deepEqual(verified.owner, {
    tenantId: "tenant_gateway_http",
    userId: "user_gateway_http",
  });
  assert.equal(verified.deviceId, "dev_gateway_http_b");
  assert.equal(verified.desktopInstanceId, "desk_gateway_http_b");
});

async function withGateway(
  config: ServerConfig,
  ownerResolverOptions: { resolveOwner?: (request: Request) => WorkspaceIdentity | undefined },
  test: (baseUrl: string, runtime: CloudGatewayRuntime, config: ServerConfig) => Promise<void>,
): Promise<void> {
  const app = express();
  const runtime = createCloudGatewayRuntime(config);
  const registered = registerCloudGatewayHttpRoutes(app, runtime, config, {
    deviceCode: {
      tokenSecret,
      verificationUri: "https://gateway.example.com/cloud/device",
      pollIntervalSeconds: 0,
      tokenTtlSeconds: 3_600,
      ...ownerResolverOptions,
    },
  });
  const server = createServer(app);

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    await test(`http://127.0.0.1:${port}`, runtime, config);
  } finally {
    await registered.close();
    await runtime.close();
    server.close();
  }
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

function testConfig(name: string): ServerConfig {
  const stateDir = `/tmp/devspace-gateway-http-routes-test-${name}`;
  return {
    host: "127.0.0.1",
    port: 7676,
    deploymentMode: "local",
    oauth: {
      mode: "owner-token",
      ownerToken: `owner_token_for_gateway_http_test_${name}`,
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 86_400,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost"],
    },
    database: {
      provider: "sqlite",
      stateDir,
      filePath: `${stateDir}/devspace.sqlite`,
    },
    allowedRoots: ["/tmp"],
    allowedHosts: ["127.0.0.1"],
    publicBaseUrl: "https://gateway.example.com",
    minimalTools: true,
    toolNaming: "short",
    widgets: "off",
    stateDir,
    worktreeRoot: `${stateDir}/worktrees`,
    workspaceSessionTtlSeconds: null,
    workspaceSessionCleanupIntervalSeconds: 3_600,
    skillsEnabled: false,
    skillPaths: [],
    agentDir: `${stateDir}/agent`,
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
