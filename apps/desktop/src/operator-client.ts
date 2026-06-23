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

export interface OperatorApprovalSummary {
  total: number;
  pending: number;
  approved: number;
  denied: number;
  latestPending?: {
    id: string;
    title: string;
    message: string;
    risk: "low" | "medium" | "high";
    requestedAt: string;
  };
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
    blocking: Array<Record<string, unknown>>;
    latest: Array<Record<string, unknown>>;
  };
  workflowSteps: Array<{
    seq: number;
    id: string;
    title?: string;
    phase?: string;
    status: "recorded" | "blocked";
    hookDecision?: string;
    hookReason?: string;
  }>;
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
  approvals: Array<Record<string, unknown>>;
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
    const runsResult = await fetchJson<{ runs: OperatorRun[] }>(fetchImpl, operatorApiUrl(daemonUrl, "/runs?limit=50"), {
      headers: authHeaders(token),
    });
    const runs = sortRuns(runsResult.body.runs ?? []);
    const selectedRunId = chooseRunId(runs, options.selectedRunId);
    const replay = selectedRunId
      ? (await fetchJson<{ replay: OperatorReplay }>(fetchImpl, operatorApiUrl(daemonUrl, `/runs/${encodeURIComponent(selectedRunId)}/replay`), {
          headers: authHeaders(token),
        })).body.replay
      : undefined;

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

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

interface JsonFetchOptions {
  headers?: HeadersInit;
  allowHttpError?: boolean;
}

interface JsonFetchResult<T> {
  response: Response;
  body: T;
}

async function fetchJson<T>(fetchImpl: FetchLike, url: string, options: JsonFetchOptions = {}): Promise<JsonFetchResult<T>> {
  const response = await fetchImpl(url, { headers: options.headers });
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

function errorBody(value: unknown): OperatorApiErrorBody | undefined {
  if (!value || typeof value !== "object") return undefined;
  const direct = value as { error?: OperatorApiErrorBody } & OperatorApiErrorBody;
  return direct.error ?? direct;
}

function errorMessageFromBody(value: unknown): string | undefined {
  const error = errorBody(value);
  return error?.message ?? error?.code;
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
