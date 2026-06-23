import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Express } from "express";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import { createOperatorServer } from "./operator-server.js";
import type { ServerConfig } from "./config.js";

const config = {
  host: "127.0.0.1",
  port: 7677,
  deploymentMode: "local",
  oauth: {
    mode: "owner-token",
    ownerToken: "owner-token-that-is-long-enough",
    stateDir: process.cwd(),
    accessTokenTtlSeconds: 3_600,
    refreshTokenTtlSeconds: 2_592_000,
    scopes: ["devspace"],
    allowedRedirectHosts: ["localhost", "127.0.0.1"],
  },
  database: { provider: "sqlite", stateDir: process.cwd(), filePath: ":memory:" },
  allowedRoots: [process.cwd()],
  allowedHosts: ["127.0.0.1", "localhost"],
  publicBaseUrl: "http://127.0.0.1:7677",
  minimalTools: true,
  toolNaming: "short",
  widgets: "full",
  stateDir: process.cwd(),
  worktreeRoot: process.cwd(),
  workspaceSessionTtlSeconds: null,
  workspaceSessionCleanupIntervalSeconds: 3_600,
  skillsEnabled: true,
  skillPaths: [],
  agentDir: process.cwd(),
  logging: {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
  },
} as ServerConfig;

const store = new InMemoryNativeAgentStore();
await store.createAgentRun({
  id: "agent_run_operator_server",
  owner: { tenantId: "tenant-a", userId: "alice" },
  workflowId: "manual",
  status: "running",
  input: { text: "operator server test" },
});

const running = createOperatorServer(config, {
  store,
  operatorToken: "operator-token",
});
const server = await listen(running.app);
const baseUrl = `http://127.0.0.1:${addressPort(server)}`;

try {
  {
    const response = await fetch(`${baseUrl}/healthz`);
    const body = await response.json() as { ok: boolean; service: string; status: string };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "devspace");
    assert.equal(body.status, "ok");
  }

  {
    const response = await fetch(`${baseUrl}/readyz`);
    const body = await response.json() as { ok: boolean; status: string; checks: { database: { provider: string } } };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, "ready");
    assert.equal(body.checks.database.provider, "sqlite");
  }

  {
    const response = await fetch(`${baseUrl}/mcp`);
    assert.equal(response.status, 404);
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs`, {
      headers: { authorization: "Bearer operator-token" },
    });
    const body = await response.json() as { runs: Array<{ id: string }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.runs.map((run) => run.id), ["agent_run_operator_server"]);
  }
} finally {
  await running.close();
  await closeServer(server);
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not bind to a TCP port.");
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
