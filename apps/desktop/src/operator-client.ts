export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7677";

export type OperatorConnectionStatus =
  | "checking"
  | "connected"
  | "token_missing"
  | "unauthorized"
  | "daemon_unavailable"
  | "not_ready"
  | "error";

export type OperatorRunStatus =
  | "queued"
  | "claiming"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface HealthReport {
  ok: boolean;
  service?: string;
  status?: string;
  version?: string;
}

export interface ReadinessReport {
  ok: boolean;
  status?: string;
  checks?: Record<string, unknown>;
  error?: OperatorApiErrorBody;
}

export interface OperatorApiErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

export interface OperatorRun {
  id: string;
  workflowId: string;
  status: OperatorRunStatus;
  attempt: number;
  permissionProfile?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface OperatorApproval {
  id: string;
  status: "pending" | "approved" | "denied";
  title: string;
  message: string;
  risk: "low" | "medium" | "high";
  requestedAt: string;
  resolvedAt?: string;
  requestedBy?: string;
  resolvedBy?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface OperatorApprovalSummary {
  total: number;
  pending: number;
  approved: number;
  denied: number;
  latestPending?: OperatorApproval;
}

export interface OperatorHookDecision {
  seq: number;
  eventName: string;
  decision: string;
  continue: boolean;
  auditOnly: boolean;
  blocking: boolean;
  createdAt: string;
  stage?: string;
  workflowId?: string;
  stepId?: string;
  stepPhase?: string;
  toolName?: string;
  risk?: string;
  ruleId?: string;
  reason?: string;
}

export interface OperatorWorkflowStep {
  seq: number;
  id: string;
  title?: string;
  phase?: string;
  action?: string;
  expectedOutput?: string;
  acceptanceCriteria: string[];
  suggestedTools: string[];
  createdAt: string;
  status: "recorded" | "blocked";
  hookDecision?: string;
  hookReason?: string;
}

export interface OperatorReplaySummary {
  agentRunId: string;
  workflowId: string;
  status: OperatorRunStatus;
  attempt: number;
  permissionProfile: string;
  terminal: boolean;
  eventCount: number;
  nextSeq: number;
  approvals: OperatorApprovalSummary;
  hooks: {
    total: number;
    allow: number;
    ask: number;
    block: number;
    deny: number;
    auditOnly: number;
    blocking: OperatorHookDecision[];
    latest: OperatorHookDecision[];
  };
  workflowSteps: OperatorWorkflowStep[];
  retries: {
    retryOfAgentRunId?: string;
    retryAgentRunIds: string[];
  };
}

export interface OperatorReplayEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorReplay {
  agentRunId: string;
  events: OperatorReplayEvent[];
  approvals: OperatorApproval[];
  summary: OperatorReplaySummary;
  nextSeq: number;
  terminal: boolean;
}

export interface OperatorConnectionSnapshot {
  status: OperatorConnectionStatus;
  daemonUrl: string;
  message: string;
  health?: HealthReport;
  readiness?: ReadinessReport;
  runs: OperatorRun[];
  selectedRunId?: string;
  replay?: OperatorReplay;
}

export interface OperatorClientOptions {
  daemonUrl?: string;
  token?: string;
  selectedRunId?: string;
  fetchImpl?: FetchLike;
}

export interface OperatorActionOptions {
  daemonUrl?: string;
  token: string;
  agentRunId: string;
  fetchImpl?: FetchLike;
}

export interface DispatchOnceOptions {
  daemonUrl?: string;
  token: string;
  workspaceRoot?: string;
  workflowId?: string;
  automationRunId?: string;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface ReplayStreamOptions {
  daemonUrl?: string;
  token: string;
  agentRunId: string;
  afterSeq?: number;
  pollMs?: number;
  maxEvents?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  onMessage: (message: ReplayStreamMessage) => void;
}

export interface ParsedSseMessage {
  event: string;
  data: unknown;
}

export interface ReplaySnapshotPayload {
  agentRunId: string;
  events: OperatorReplayEvent[];
  approvals: OperatorApproval[];
  summary: OperatorReplaySummary;
  nextSeq: number;
  terminal: boolean;
  requestId?: string;
}

export interface ReplayDeltaPayload {
  agentRunId: string;
  event?: OperatorReplayEvent;
  summary?: OperatorReplaySummary;
  nextSeq?: number;
  terminal?: boolean;
  requestId?: string;
  error?: OperatorApiErrorBody;
}

export interface ReplayStreamMessage {
  event: string;
  data: ReplaySnapshotPayload | ReplayDeltaPayload | Record<string, unknown>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ACTIVE_STATUSES = new Set<OperatorRunStatus>(["queued", "claiming", "running", "waiting_input"]);

export class OperatorClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OperatorClientError";
  }
}

export async function loadOperatorSnapshot(options: OperatorClientOptions = {}): Promise<OperatorConnectionSnapshot> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  let health: HealthReport;
  try {
    health = (await fetchJson<HealthReport>(fetchImpl, `${daemonUrl}/healthz`)).body;
  } catch (error) {
    return snapshot("daemon_unavailable", daemonUrl, daemonUnavailableMessage(error));
  }

  if (health.ok === false) {
    return snapshot("error", daemonUrl, "Local operator daemon health check failed.", { health });
  }

  let readinessResult: JsonFetchResult<ReadinessReport>;
  try {
    readinessResult = await fetchJson<ReadinessReport>(fetchImpl, `${daemonUrl}/readyz`, { allowHttpError: true });
  } catch (error) {
    return snapshot("daemon_unavailable", daemonUrl, daemonUnavailableMessage(error), { health });
  }

  if (!readinessResult.response.ok || readinessResult.body.ok === false) {
    return snapshot(
      "not_ready",
      daemonUrl,
      errorMessageFromBody(readinessResult.body) ?? "Local operator daemon is running, but Postgres schema is not ready.",
      { health, readiness: readinessResult.body },
    );
  }

  const token = options.token?.trim();
  if (!token) {
    return snapshot("token_missing", daemonUrl, "Enter the operator token to connect to the local daemon.", {
      health,
      readiness: readinessResult.body,
    });
  }

  try {
    const runs = await listOperatorRuns({ daemonUrl, token, fetchImpl });
    const selectedRunId = chooseRunId(runs, options.selectedRunId);
    const replay = selectedRunId ? await fetchOperatorReplay({ daemonUrl, token, agentRunId: selectedRunId, fetchImpl }) : undefined;

    return {
      status: "connected",
      daemonUrl,
      message: runs.length === 0 ? "Connected. No native agent runs have been recorded yet." : "Connected to the local operator daemon.",
      health,
      readiness: readinessResult.body,
      runs,
      selectedRunId,
      replay,
    };
  } catch (error) {
    if (error instanceof OperatorClientError && error.status === 401) {
      return snapshot("unauthorized", daemonUrl, "Operator token was rejected by the local daemon.", {
        health,
        readiness: readinessResult.body,
      });
    }
    return snapshot("error", daemonUrl, error instanceof Error ? error.message : String(error), {
      health,
      readiness: readinessResult.body,
    });
  }
}

export async function listOperatorRuns(options: { daemonUrl?: string; token: string; fetchImpl?: FetchLike; limit?: number }): Promise<OperatorRun[]> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const limit = options.limit ?? 50;
  const result = await fetchJson<{ runs: OperatorRun[] }>(options.fetchImpl ?? fetch, operatorApiUrl(daemonUrl, `/runs?limit=${limit}`), {
    headers: authHeaders(options.token),
  });
  return sortRuns(result.body.runs ?? []);
}

export async function fetchOperatorReplay(options: OperatorActionOptions): Promise<OperatorReplay> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const result = await fetchJson<{ replay: OperatorReplay }>(options.fetchImpl ?? fetch, operatorApiUrl(daemonUrl, `/runs/${encodeURIComponent(options.agentRunId)}/replay`), {
    headers: authHeaders(options.token),
  });
  return result.body.replay;
}

export async function resolveOperatorApproval(
  options: OperatorActionOptions & { approvalId: string; decision: "approved" | "denied"; message?: string },
): Promise<OperatorApproval> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const result = await fetchJson<{ approval: OperatorApproval }>(options.fetchImpl ?? fetch, operatorApiUrl(daemonUrl, `/runs/${encodeURIComponent(options.agentRunId)}/approvals/${encodeURIComponent(options.approvalId)}/resolve`), {
    method: "POST",
    headers: authHeaders(options.token),
    body: compactBody({
      decision: options.decision,
      resolvedBy: "xautojs-desktop",
      message: options.message,
    }),
  });
  return result.body.approval;
}

export async function resumeOperatorRun(options: OperatorActionOptions & { workspaceRoot?: string }): Promise<Record<string, unknown>> {
  return operatorPost(options, `/runs/${encodeURIComponent(options.agentRunId)}/resume`, {
    workspaceRoot: options.workspaceRoot,
  });
}

export async function retryOperatorRun(options: OperatorActionOptions & { reason?: string }): Promise<Record<string, unknown>> {
  return operatorPost(options, `/runs/${encodeURIComponent(options.agentRunId)}/retry`, {
    reason: options.reason,
  });
}

export async function cancelOperatorRun(options: OperatorActionOptions & { reason?: string }): Promise<Record<string, unknown>> {
  return operatorPost(options, `/runs/${encodeURIComponent(options.agentRunId)}/cancel`, {
    reason: options.reason,
  });
}

export async function dispatchOperatorOnce(options: DispatchOnceOptions): Promise<Record<string, unknown>> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const result = await fetchJson<Record<string, unknown>>(options.fetchImpl ?? fetch, operatorApiUrl(daemonUrl, "/dispatch/once"), {
    method: "POST",
    headers: authHeaders(options.token),
    body: compactBody({
      workspaceRoot: options.workspaceRoot,
      workflowId: options.workflowId || "manual",
      automationRunId: options.automationRunId,
      timeoutMs: options.timeoutMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
    }),
  });
  return result.body;
}

export async function streamOperatorReplay(options: ReplayStreamOptions): Promise<void> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams({
    afterSeq: String(options.afterSeq ?? 0),
    pollMs: String(options.pollMs ?? 1_000),
    maxEvents: String(options.maxEvents ?? 100),
  });
  const response = await fetchImpl(operatorApiUrl(daemonUrl, `/runs/${encodeURIComponent(options.agentRunId)}/stream?${query.toString()}`), {
    headers: authHeaders(options.token),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await parseJsonBody<unknown>(response);
    const error = errorBody(body);
    throw new OperatorClientError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? `Replay stream failed with HTTP ${response.status}.`,
      error?.retryable ?? response.status >= 500,
    );
  }
  if (!response.body) {
    throw new OperatorClientError(0, "REPLAY_STREAM_UNAVAILABLE", "Replay stream response body is unavailable.", true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseMessages(buffered);
      buffered = parsed.rest;
      for (const message of parsed.messages) options.onMessage(message as ReplayStreamMessage);
    }
    buffered += decoder.decode();
    const parsed = parseSseMessages(`${buffered}\n\n`);
    for (const message of parsed.messages) options.onMessage(message as ReplayStreamMessage);
  } finally {
    reader.releaseLock();
  }
}

export function parseSseMessages(input: string): { messages: ParsedSseMessage[]; rest: string } {
  const normalized = input.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const messages = parts.map(parseSseBlock).filter((message): message is ParsedSseMessage => Boolean(message));
  return { messages, rest };
}

export function mergeReplayStreamMessage(current: OperatorReplay | undefined, message: ReplayStreamMessage): OperatorReplay | undefined {
  if (message.event === "replay.snapshot") {
    const snapshot = message.data as ReplaySnapshotPayload;
    return {
      agentRunId: snapshot.agentRunId,
      events: snapshot.events ?? [],
      approvals: snapshot.approvals ?? [],
      summary: snapshot.summary,
      nextSeq: snapshot.nextSeq,
      terminal: snapshot.terminal,
    };
  }
  if (!current || message.event === "heartbeat" || message.event === "error") return current;

  const delta = message.data as ReplayDeltaPayload;
  const event = delta.event;
  const events = event && !current.events.some((existing) => existing.seq === event.seq)
    ? [...current.events, event].sort((left, right) => left.seq - right.seq)
    : current.events;

  return {
    ...current,
    events,
    summary: delta.summary ?? current.summary,
    nextSeq: delta.nextSeq ?? current.nextSeq,
    terminal: delta.terminal ?? current.terminal,
  };
}

export function pendingApproval(replay?: OperatorReplay): OperatorApproval | undefined {
  return replay?.summary.approvals.latestPending
    ?? replay?.approvals.find((approval) => approval.status === "pending");
}

export function normalizeDaemonUrl(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_DAEMON_URL;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(candidate);
  return parsed.toString().replace(/\/+$/, "");
}

export function operatorApiUrl(daemonUrl: string, path: string): string {
  const normalized = normalizeDaemonUrl(daemonUrl);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${normalized}/api/native-agent${suffix}`;
}

export function chooseRunId(runs: OperatorRun[], selectedRunId?: string): string | undefined {
  if (selectedRunId && runs.some((run) => run.id === selectedRunId)) return selectedRunId;
  const waiting = runs.find((run) => run.status === "waiting_input");
  if (waiting) return waiting.id;
  const active = runs.find((run) => ACTIVE_STATUSES.has(run.status));
  if (active) return active.id;
  return runs[0]?.id;
}

export function sortRuns(runs: OperatorRun[]): OperatorRun[] {
  return [...runs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function statusLabel(status: OperatorConnectionStatus): string {
  switch (status) {
    case "checking":
      return "Checking";
    case "connected":
      return "Connected";
    case "token_missing":
      return "Token needed";
    case "unauthorized":
      return "Token rejected";
    case "daemon_unavailable":
      return "Daemon offline";
    case "not_ready":
      return "Schema not ready";
    case "error":
      return "Needs attention";
  }
}

async function operatorPost(options: OperatorActionOptions, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const result = await fetchJson<Record<string, unknown>>(options.fetchImpl ?? fetch, operatorApiUrl(daemonUrl, path), {
    method: "POST",
    headers: authHeaders(options.token),
    body: compactBody(body),
  });
  return result.body;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface JsonFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  allowHttpError?: boolean;
}

interface JsonFetchResult<T> {
  response: Response;
  body: T;
}

async function fetchJson<T>(fetchImpl: FetchLike, url: string, options: JsonFetchOptions = {}): Promise<JsonFetchResult<T>> {
  const headers = options.body ? { ...options.headers, "content-type": "application/json" } : options.headers;
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await parseJsonBody<T>(response);
  if (!response.ok && !options.allowHttpError) {
    const error = errorBody(body);
    throw new OperatorClientError(
      response.status,
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? `Request failed with HTTP ${response.status}.`,
      error?.retryable ?? response.status >= 500,
    );
  }
  return { response, body };
}

async function parseJsonBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { error: { message: text } } as T;
  }
}

function parseSseBlock(block: string): ParsedSseMessage | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  const dataText = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataText);
  } catch {
    data = dataText;
  }
  return { event, data };
}

function errorBody(value: unknown): OperatorApiErrorBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const direct = value as { error?: OperatorApiErrorBody } & OperatorApiErrorBody;
  return direct.error ?? direct;
}

function errorMessageFromBody(value: unknown): string | undefined {
  const error = errorBody(value);
  return error?.message ?? error?.code;
}

function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function snapshot(
  status: OperatorConnectionStatus,
  daemonUrl: string,
  message: string,
  extra: Partial<Pick<OperatorConnectionSnapshot, "health" | "readiness">> = {},
): OperatorConnectionSnapshot {
  return {
    status,
    daemonUrl,
    message,
    runs: [],
    ...extra,
  };
}

function daemonUnavailableMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Cannot reach the local operator daemon: ${error.message}`;
  }
  return "Cannot reach the local operator daemon on 127.0.0.1.";
}
