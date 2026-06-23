import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import { InMemoryNativeAgentStore } from "./native-agent-store.js";
import { registerNativeAgentApiRoutes } from "./native-agent-api.js";
import type { ServerConfig } from "./config.js";

const config = {
  database: { provider: "sqlite", stateDir: process.cwd(), filePath: ":memory:" },
  allowedRoots: [process.cwd()],
  worktreeRoot: process.cwd(),
} as ServerConfig;
const store = new InMemoryNativeAgentStore();
const run = await store.createAgentRun({
  id: "agent_run_api",
  owner: { tenantId: "tenant-a", userId: "alice" },
  workflowId: "manual",
  status: "running",
  input: { text: "inspect workspace" },
});
await store.appendRunEvent({ agentRunId: run.id, type: "run.started", payload: { workflowId: "manual" } });

const app = express();
const registration = registerNativeAgentApiRoutes(app, config, { store, operatorToken: "operator-token" });
const server = await listen(app);
const baseUrl = `http://127.0.0.1:${addressPort(server)}`;

try {
  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs`);
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "NATIVE_AGENT_OPERATOR_TOKEN_INVALID");
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs`, {
      headers: { authorization: "Bearer operator-token" },
    });
    const body = await response.json() as { runs: Array<{ id: string }>; requestId: string };
    assert.equal(response.status, 200);
    assert.equal(body.runs[0]?.id, "agent_run_api");
    assert.ok(body.requestId);
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs?status=bogus`, {
      headers: { authorization: "Bearer operator-token" },
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_AGENT_RUN_STATUS");
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/events?afterSeq=0`, {
      headers: { authorization: "Bearer operator-token" },
    });
    const body = await response.json() as { events: Array<{ seq: number; type: string }>; nextSeq: number };
    assert.equal(response.status, 200);
    assert.equal(body.events[0]?.seq, 1);
    assert.equal(body.events[0]?.type, "run.started");
    assert.equal(body.nextSeq, 2);
  }

  let approvalId = "";
  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/approvals`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Run tests", message: "Allow npm test", risk: "medium", requestedBy: "api-test" }),
    });
    const body = await response.json() as { approval: { id: string; status: string } };
    assert.equal(response.status, 201);
    assert.equal(body.approval.status, "pending");
    approvalId = body.approval.id;
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approved", resolvedBy: "owner" }),
    });
    const body = await response.json() as { approval: { id: string; status: string; resolvedBy: string } };
    assert.equal(response.status, 200);
    assert.equal(body.approval.id, approvalId);
    assert.equal(body.approval.status, "approved");
    assert.equal(body.approval.resolvedBy, "owner");
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/replay`, {
      headers: { authorization: "Bearer operator-token" },
    });
    const body = await response.json() as { replay: { approvals: Array<{ status: string }>; events: Array<{ type: string }> } };
    assert.equal(response.status, 200);
    assert.equal(body.replay.approvals[0]?.status, "approved");
    assert.ok(body.replay.events.some((event) => event.type === "run.approval.requested"));
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/cancel`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "unit test" }),
    });
    const body = await response.json() as { run: { id: string; status: string; errorCode: string } };
    assert.equal(response.status, 200);
    assert.equal(body.run.id, "agent_run_api");
    assert.equal(body.run.status, "cancelled");
    assert.equal(body.run.errorCode, "AGENT_RUN_CANCELLED");
  }

  {
    const response = await fetch(`${baseUrl}/api/native-agent/runs/agent_run_api/retry`, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "try again" }),
    });
    const body = await response.json() as { retry: { status: string; attempt: number; input: { retryOfAgentRunId: string } } };
    assert.equal(response.status, 201);
    assert.equal(body.retry.status, "queued");
    assert.equal(body.retry.attempt, 2);
    assert.equal(body.retry.input.retryOfAgentRunId, "agent_run_api");
  }
} finally {
  await registration.close();
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
