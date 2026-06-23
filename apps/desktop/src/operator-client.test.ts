import assert from "node:assert/strict";
import {
  chooseRunId,
  dispatchOperatorOnce,
  loadOperatorSnapshot,
  mergeReplayStreamMessage,
  normalizeDaemonUrl,
  operatorApiUrl,
  parseSseMessages,
  resolveOperatorApproval,
  resumeOperatorRun,
  retryOperatorRun,
  sortRuns,
  streamOperatorReplay,
  type FetchLike,
  type OperatorReplay,
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

const replay: OperatorReplay = {
  agentRunId: "agent_run_waiting",
  events: [],
  approvals: [],
  nextSeq: 1,
  terminal: false,
  summary: replaySummary("waiting_input", 1),
};

assert.equal(normalizeDaemonUrl(undefined), "http://127.0.0.1:7677");
assert.equal(normalizeDaemonUrl("127.0.0.1:7677/"), "http://127.0.0.1:7677");
assert.equal(operatorApiUrl("http://127.0.0.1:7677/", "/runs"), "http://127.0.0.1:7677/api/native-agent/runs");
assert.equal(chooseRunId(runs), "agent_run_waiting");
assert.equal(chooseRunId(runs, "agent_run_done"), "agent_run_done");
assert.deepEqual(sortRuns(runs).map((run) => run.id), ["agent_run_waiting", "agent_run_done"]);

{
  const calls: RequestCall[] = [];
  const snapshot = await loadOperatorSnapshot({
    daemonUrl: "http://127.0.0.1:7677",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
    }, calls),
  });
  assert.equal(snapshot.status, "token_missing");
  assert.equal(snapshot.runs.length, 0);
  assert.deepEqual(calls.map((call) => call.key), ["/healthz", "/readyz"]);
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
  const calls: RequestCall[] = [];
  const snapshot = await loadOperatorSnapshot({
    token: "operator-token",
    fetchImpl: mockFetch({
      "/healthz": json({ ok: true, service: "devspace", status: "ok" }),
      "/readyz": json({ ok: true, status: "ready" }),
      "/api/native-agent/runs?limit=50": json({ runs }),
      "/api/native-agent/runs/agent_run_waiting/replay": json({ replay }),
    }, calls),
  });
  assert.equal(snapshot.status, "connected");
  assert.equal(snapshot.selectedRunId, "agent_run_waiting");
  assert.equal(snapshot.replay?.summary.status, "waiting_input");
  assert.deepEqual(calls.map((call) => call.key), [
    "/healthz",
    "/readyz",
    "/api/native-agent/runs?limit=50",
    "/api/native-agent/runs/agent_run_waiting/replay",
  ]);
}

{
  const calls: RequestCall[] = [];
  const approval = await resolveOperatorApproval({
    daemonUrl: "http://127.0.0.1:7677",
    token: "operator-token",
    agentRunId: "agent_run_waiting",
    approvalId: "approval_1",
    decision: "approved",
    message: "Ship it",
    fetchImpl: mockFetch({
      "/api/native-agent/runs/agent_run_waiting/approvals/approval_1/resolve": json({
        approval: {
          id: "approval_1",
          status: "approved",
          title: "Run tests",
          message: "Allow npm test",
          risk: "medium",
          request: {},
          response: {},
          requestedAt: "2026-06-23T00:00:00.000Z",
        },
      }),
    }, calls),
  });
  assert.equal(approval.status, "approved");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.authorization, "Bearer operator-token");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    decision: "approved",
    resolvedBy: "xautojs-desktop",
    message: "Ship it",
  });
}

{
  const calls: RequestCall[] = [];
  await resumeOperatorRun({
    daemonUrl: "http://127.0.0.1:7677",
    token: "operator-token",
    agentRunId: "agent_run_waiting",
    workspaceRoot: "/workspace/project",
    fetchImpl: mockFetch({
      "/api/native-agent/runs/agent_run_waiting/resume": json({ claimed: true }),
    }, calls),
  });
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { workspaceRoot: "/workspace/project" });
}

{
  const calls: RequestCall[] = [];
  await retryOperatorRun({
    daemonUrl: "http://127.0.0.1:7677",
    token: "operator-token",
    agentRunId: "agent_run_waiting",
    reason: "try again",
    fetchImpl: mockFetch({
      "/api/native-agent/runs/agent_run_waiting/retry": json({ retry: { id: "agent_run_retry" } }, { status: 201 }),
    }, calls),
  });
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), { reason: "try again" });
}

{
  const calls: RequestCall[] = [];
  await dispatchOperatorOnce({
    daemonUrl: "http://127.0.0.1:7677",
    token: "operator-token",
    workspaceRoot: "/workspace/project",
    workflowId: "feature-dev",
    automationRunId: "",
    fetchImpl: mockFetch({
      "/api/native-agent/dispatch/once": json({ claimed: false }),
    }, calls),
  });
  assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
    workspaceRoot: "/workspace/project",
    workflowId: "feature-dev",
  });
}

{
  const parsed = parseSseMessages("event: replay.snapshot\ndata: {\"agentRunId\":\"a\",\"events\":[],\"approvals\":[],\"summary\":{},\"nextSeq\":1,\"terminal\":false}\n\nevent: heartbeat\ndata: {\"nextSeq\":1}\n\nevent: run.event\n");
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0]?.event, "replay.snapshot");
  assert.equal(parsed.messages[1]?.event, "heartbeat");
  assert.equal(parsed.rest, "event: run.event\n");
}

{
  const snapshot = mergeReplayStreamMessage(undefined, {
    event: "replay.snapshot",
    data: {
      agentRunId: "agent_run_waiting",
      events: [],
      approvals: [],
      summary: replaySummary("running", 1),
      nextSeq: 1,
      terminal: false,
    },
  });
  assert.equal(snapshot?.summary.status, "running");
  const updated = mergeReplayStreamMessage(snapshot, {
    event: "workflow.step",
    data: {
      agentRunId: "agent_run_waiting",
      event: {
        seq: 1,
        type: "run.loop.step",
        payload: { title: "Run tests" },
        createdAt: "2026-06-23T00:04:00.000Z",
      },
      summary: replaySummary("running", 2),
      nextSeq: 2,
      terminal: false,
    },
  });
  assert.equal(updated?.events.length, 1);
  assert.equal(updated?.nextSeq, 2);
}

{
  const calls: RequestCall[] = [];
  const messages: string[] = [];
  await streamOperatorReplay({
    daemonUrl: "http://127.0.0.1:7677",
    token: "operator-token",
    agentRunId: "agent_run_waiting",
    afterSeq: 4,
    pollMs: 50,
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push(callFrom(url, init));
      return streamResponse([
        "event: replay.snapshot\n",
        "data: {\"agentRunId\":\"agent_run_waiting\",\"events\":[],\"approvals\":[],\"summary\":{\"agentRunId\":\"agent_run_waiting\",\"workflowId\":\"manual\",\"status\":\"running\",\"attempt\":1,\"permissionProfile\":\"workspace_write\",\"terminal\":false,\"eventCount\":0,\"nextSeq\":5,\"approvals\":{\"total\":0,\"pending\":0,\"approved\":0,\"denied\":0},\"hooks\":{\"total\":0,\"allow\":0,\"ask\":0,\"block\":0,\"deny\":0,\"auditOnly\":0,\"blocking\":[],\"latest\":[]},\"workflowSteps\":[],\"retries\":{\"retryAgentRunIds\":[]}},\"nextSeq\":5,\"terminal\":false}\n\n",
        "event: heartbeat\ndata: {\"agentRunId\":\"agent_run_waiting\",\"nextSeq\":5,\"terminal\":false}\n\n",
      ]);
    },
    onMessage: (message) => messages.push(message.event),
  });
  assert.deepEqual(messages, ["replay.snapshot", "heartbeat"]);
  assert.equal(calls[0]?.key, "/api/native-agent/runs/agent_run_waiting/stream?afterSeq=4&pollMs=50&maxEvents=100");
  assert.equal(calls[0]?.headers.authorization, "Bearer operator-token");
}

interface RequestCall {
  key: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(routes: Record<string, Response>, calls: RequestCall[] = []): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    const call = callFrom(url, init);
    calls.push(call);
    const response = routes[call.key];
    if (!response) {
      throw new Error(`Unexpected request: ${call.key} ${JSON.stringify(init?.headers ?? {})}`);
    }
    return response.clone();
  };
}

function callFrom(url: URL, init?: RequestInit): RequestCall {
  return {
    key: `${url.pathname}${url.search}`,
    method: init?.method ?? "GET",
    headers: headersObject(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined,
  };
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
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

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    headers: { "content-type": "text/event-stream" },
  });
}

function replaySummary(status: OperatorRun["status"], nextSeq: number) {
  return {
    agentRunId: "agent_run_waiting",
    workflowId: "feature-dev",
    status,
    attempt: 2,
    permissionProfile: "workspace_write",
    terminal: false,
    eventCount: Math.max(0, nextSeq - 1),
    nextSeq,
    approvals: { total: 0, pending: 0, approved: 0, denied: 0 },
    hooks: { total: 0, allow: 0, ask: 0, block: 0, deny: 0, auditOnly: 0, blocking: [], latest: [] },
    workflowSteps: [],
    retries: { retryAgentRunIds: [] },
  };
}
