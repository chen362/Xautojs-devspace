import assert from "node:assert/strict";
import {
  chooseRunId,
  loadOperatorSnapshot,
  normalizeDaemonUrl,
  operatorApiUrl,
  sortRuns,
  type FetchLike,
  type OperatorRun,
} from "./operator-client.js";

const runs: OperatorRun[] = [
  {
    id: "agent_run_done",
    workflowId: "manual",
    status: "succeeded",
    attempt: 1,
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:02:00.000Z",
  },
  {
    id: "agent_run_waiting",
    workflowId: "feature-dev",
    status: "waiting_input",
    attempt: 2,
    createdAt: "2026-06-23T00:01:00.000Z",
    updatedAt: "2026-06-23T00:03:00.000Z",
  },
];

assert.equal(normalizeDaemonUrl(undefined), "http://127.0.0.1:7677");
assert.equal(normalizeDaemonUrl("127.0.0.1:7677/"), "http://127.0.0.1:7677");
assert.equal(operatorApiUrl("http://127.0.0.1:7677/", "/runs"), "http://127.0.0.1:7677/api/native-agent/runs");
assert.equal(chooseRunId(runs), "agent_run_waiting");
assert.equal(chooseRunId(runs, "agent_run_done"), "agent_run_done");
assert.deepEqual(sortRuns(runs).map((run) => run.id), ["agent_run_waiting", "agent_run_done"]);

{
  const calls: string[] = [];
  const snapshot = await loadOperatorSnapshot({
    daemonUrl: "http://127.0.0.1:7677",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
    }, calls),
  });
  assert.equal(snapshot.status, "token_missing");
  assert.equal(snapshot.runs.length, 0);
  assert.deepEqual(calls, ["/healthz", "/readyz"]);
}

{
  const snapshot = await loadOperatorSnapshot({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(snapshot.status, "daemon_unavailable");
  assert.match(snapshot.message, /fetch failed/);
}

{
  const snapshot = await loadOperatorSnapshot({
    token: "operator-token",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: false, status: "not_ready", error: { code: "POSTGRES_SCHEMA_NOT_READY", message: "Run migrations first." } }, { status: 503 }),
    }),
  });
  assert.equal(snapshot.status, "not_ready");
  assert.equal(snapshot.message, "Run migrations first.");
}

{
  const snapshot = await loadOperatorSnapshot({
    token: "bad-token",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
      "/api/native-agent/runs?limit=50": json({ error: { code: "NATIVE_AGENT_OPERATOR_TOKEN_INVALID", message: "Invalid token." } }, { status: 401 }),
    }),
  });
  assert.equal(snapshot.status, "unauthorized");
  assert.equal(snapshot.message, "Operator token was rejected by the local daemon.");
}

{
  const snapshot = await loadOperatorSnapshot({
    token: "operator-token",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
      "/api/native-agent/runs?limit=50": json({ runs: [] }),
    }),
  });
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.runs.length, 0);
  assert.match(snapshot.message, /No native agent runs/);
}

{
  const calls: string[] = [];
  const snapshot = await loadOperatorSnapshot({
    token: "operator-token",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
      "/api/native-agent/runs?limit=50": json({ runs }),
      "/api/native-agent/runs/agent_run_waiting/replay": json({
        replay: {
          agentRunId: "agent_run_waiting",
          events: [],
          approvals: [],
          nextSeq: 1,
          terminal: false,
          summary: {
            agentRunId: "agent_run_waiting",
            workflowId: "feature-dev",
            status: "waiting_input",
            attempt: 2,
            permissionProfile: "workspace_write",
            terminal: false,
            eventCount: 0,
            nextSeq: 1,
            approvals: { total: 0, pending: 0, approved: 0, denied: 0 },
            hooks: { total: 0, allow: 0, ask: 0, block: 0, deny: 0, auditOnly: 0, blocking: [], latest: [] },
            workflowSteps: [],
            retries: { retryAgentRunIds: [] },
          },
        },
      }),
    }, calls),
  });
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.selectedRunId, "agent_run_waiting");
  assert.equal(snapshot.replay?.summary.status, "waiting_input");
  assert.deepEqual(calls, [
    "/healthz",
    "/readyz",
    "/api/native-agent/runs?limit=50",
    "/api/native-agent/runs/agent_run_waiting/replay",
  ]);
}

function mockFetch(routes: Record<string, Response>, calls: string[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    const response = routes[key];
    if (!response) {
      throw new Error(`Unexpected request: ${key} ${JSON.stringify(init?.headers ?? {})}`);
    }
    return response.clone();
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}
