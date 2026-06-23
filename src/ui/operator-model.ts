export type OperatorRunStatus =
  | "queued"
  | "claiming"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

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

export interface OperatorReplayEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
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
  approvals: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
    latestPending?: OperatorApproval;
  };
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

export interface OperatorReplay {
  agentRunId: string;
  events: OperatorReplayEvent[];
  approvals: OperatorApproval[];
  summary: OperatorReplaySummary;
  nextSeq: number;
  terminal: boolean;
}

export const RUN_STATUS_FILTERS: Array<OperatorRunStatus | "all"> = [
  "all",
  "queued",
  "claiming",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];

const TERMINAL_STATUSES = new Set<OperatorRunStatus>(["succeeded", "failed", "cancelled", "timed_out"]);
const ACTIVE_STATUSES = new Set<OperatorRunStatus>(["queued", "claiming", "running", "waiting_input"]);

export function isTerminalStatus(status: OperatorRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function statusTone(status: OperatorRunStatus): "active" | "success" | "danger" | "muted" | "warning" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "cancelled") return "muted";
  if (status === "waiting_input") return "warning";
  return "active";
}

export function decisionTone(decision: string | undefined): "success" | "danger" | "warning" | "muted" {
  if (decision === "allow" || decision === "audit_only") return "success";
  if (decision === "block" || decision === "deny") return "danger";
  if (decision === "ask") return "warning";
  return "muted";
}

export function filterRuns(runs: OperatorRun[], status: OperatorRunStatus | "all"): OperatorRun[] {
  const visible = status === "all" ? runs : runs.filter((run) => run.status === status);
  return [...visible].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function chooseRunId(runs: OperatorRun[], currentId?: string): string | undefined {
  if (currentId && runs.some((run) => run.id === currentId)) return currentId;
  const waiting = runs.find((run) => run.status === "waiting_input");
  if (waiting) return waiting.id;
  const active = runs.find((run) => ACTIVE_STATUSES.has(run.status));
  if (active) return active.id;
  return runs[0]?.id;
}

export function summarizeRuns(runs: OperatorRun[]): {
  total: number;
  active: number;
  waiting: number;
  failed: number;
  terminal: number;
} {
  return {
    total: runs.length,
    active: runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length,
    waiting: runs.filter((run) => run.status === "waiting_input").length,
    failed: runs.filter((run) => run.status === "failed" || run.status === "timed_out").length,
    terminal: runs.filter((run) => TERMINAL_STATUSES.has(run.status)).length,
  };
}

export function pendingApproval(replay?: OperatorReplay): OperatorApproval | undefined {
  return replay?.summary.approvals.latestPending
    ?? replay?.approvals.find((approval) => approval.status === "pending");
}

export function blockingHookCount(replay?: OperatorReplay): number {
  return replay?.summary.hooks.blocking.length ?? 0;
}

export function eventTitle(event: OperatorReplayEvent): string {
  switch (event.type) {
    case "run.started":
      return "Run started";
    case "run.completed":
      return "Run completed";
    case "run.failed":
      return "Run failed";
    case "run.cancelled":
      return "Run cancelled";
    case "run.approval.requested":
      return "Approval requested";
    case "run.approval.resolved":
      return "Approval resolved";
    case "run.hook.decision":
      return "Hook decision";
    case "run.loop.step":
      return "Workflow step";
    case "run.retry.created":
      return "Retry created";
    case "run.retry.source":
      return "Retry source";
    default:
      return event.type.replace(/^run\./, "Run ").replace(/[._-]/g, " ");
  }
}

export function eventDetail(event: OperatorReplayEvent): string {
  if (event.type === "run.hook.decision") {
    const decision = stringValue(event.payload.decision) ?? "decision";
    const hook = stringValue(event.payload.hookEventName) ?? stringValue(event.payload.eventName) ?? "hook";
    const reason = stringValue(event.payload.reason);
    return reason ? `${hook}: ${decision} - ${reason}` : `${hook}: ${decision}`;
  }
  if (event.type === "run.approval.requested") {
    return stringValue(event.payload.title) ?? stringValue(event.payload.message) ?? "Approval requested";
  }
  if (event.type === "run.approval.resolved") {
    return stringValue(event.payload.decision) ?? "Approval resolved";
  }
  if (event.type === "run.loop.step") {
    return stringValue(event.payload.title) ?? stringValue(event.payload.id) ?? "Workflow step";
  }
  return JSON.stringify(event.payload);
}

export function compactId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

export function timeAgo(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatDateTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
