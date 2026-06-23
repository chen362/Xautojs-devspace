import { randomUUID } from "node:crypto";
import {
  isTerminalNativeAgentRunStatus,
  type NativeAgentRun,
  type NativeAgentRunEvent,
  type NativeAgentStore,
  type NativeAgentToolRisk,
} from "./native-agent-store.js";
import type { JsonObject, JsonValue } from "./postgres-automation-store.js";

export type NativeAgentApprovalStatus = "pending" | "approved" | "denied";
export type NativeAgentApprovalDecision = "approved" | "denied";

export interface NativeAgentApproval {
  id: string;
  agentRunId: string;
  status: NativeAgentApprovalStatus;
  title: string;
  message: string;
  risk: NativeAgentToolRisk;
  request: JsonObject;
  requestedBy?: string;
  response: JsonObject;
  resolvedBy?: string;
  requestedAt: string;
  resolvedAt?: string;
}

export interface NativeAgentReplay {
  agentRunId: string;
  events: NativeAgentRunEvent[];
  approvals: NativeAgentApproval[];
  nextSeq: number;
  terminal: boolean;
}

export class NativeAgentOperatorError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeAgentOperatorError";
  }
}

export async function requestNativeAgentApproval(
  store: NativeAgentStore,
  input: {
    agentRunId: string;
    title: string;
    message: string;
    risk?: NativeAgentToolRisk;
    request?: JsonObject;
    requestedBy?: string;
    approvalId?: string;
  },
): Promise<NativeAgentApproval> {
  const run = await requireRun(store, input.agentRunId);
  const id = input.approvalId ?? `agent_approval_${randomUUID()}`;
  const event = await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.approval.requested",
    payload: compactJson({
      approvalId: id,
      title: input.title,
      message: input.message,
      risk: input.risk ?? "medium",
      request: input.request ?? {},
      requestedBy: input.requestedBy,
    }),
  });
  return {
    id,
    agentRunId: run.id,
    status: "pending",
    title: input.title,
    message: input.message,
    risk: input.risk ?? "medium",
    request: input.request ?? {},
    requestedBy: input.requestedBy,
    response: {},
    requestedAt: event.createdAt,
  };
}

export async function resolveNativeAgentApproval(
  store: NativeAgentStore,
  input: {
    agentRunId: string;
    approvalId: string;
    decision: NativeAgentApprovalDecision;
    response?: JsonObject;
    resolvedBy?: string;
  },
): Promise<NativeAgentApproval> {
  await requireRun(store, input.agentRunId);
  const approvals = await listNativeAgentApprovals(store, { agentRunId: input.agentRunId });
  const approval = approvals.find((entry) => entry.id === input.approvalId);
  if (!approval) {
    throw new NativeAgentOperatorError(404, "NATIVE_APPROVAL_NOT_FOUND", "Native agent approval was not found.", false);
  }
  if (approval.status !== "pending") return approval;

  const event = await store.appendRunEvent({
    agentRunId: input.agentRunId,
    type: "run.approval.resolved",
    payload: compactJson({
      approvalId: input.approvalId,
      decision: input.decision,
      response: input.response ?? {},
      resolvedBy: input.resolvedBy,
    }),
  });
  return {
    ...approval,
    status: input.decision,
    response: input.response ?? {},
    resolvedBy: input.resolvedBy,
    resolvedAt: event.createdAt,
  };
}

export async function listNativeAgentApprovals(
  store: NativeAgentStore,
  input: { agentRunId: string },
): Promise<NativeAgentApproval[]> {
  await requireRun(store, input.agentRunId);
  return approvalsFromEvents(await readAllRunEvents(store, input.agentRunId));
}

export async function replayNativeAgentRun(
  store: NativeAgentStore,
  input: { agentRunId: string },
): Promise<NativeAgentReplay> {
  const run = await requireRun(store, input.agentRunId);
  const events = await readAllRunEvents(store, input.agentRunId);
  const nextSeq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 1;
  return {
    agentRunId: input.agentRunId,
    events,
    approvals: approvalsFromEvents(events),
    nextSeq,
    terminal: isTerminalNativeAgentRunStatus(run.status),
  };
}

export async function createNativeAgentRetry(
  store: NativeAgentStore,
  input: {
    agentRunId: string;
    reason?: string;
    retryId?: string;
  },
): Promise<NativeAgentRun> {
  const source = await requireRun(store, input.agentRunId);
  if (!isTerminalNativeAgentRunStatus(source.status)) {
    throw new NativeAgentOperatorError(409, "NATIVE_RUN_NOT_TERMINAL", "Only terminal native agent runs can be retried.", false);
  }

  const retry = await store.createAgentRun({
    id: input.retryId,
    owner: { tenantId: source.tenantId, userId: source.userId },
    workspaceSessionId: source.workspaceSessionId,
    workflowId: source.workflowId,
    status: "queued",
    attempt: source.attempt + 1,
    permissionProfile: source.permissionProfile,
    input: compactJson({
      ...source.input,
      retryOfAgentRunId: source.id,
      retryReason: input.reason,
    }),
  });

  await store.appendRunEvent({
    agentRunId: source.id,
    type: "run.retry.created",
    payload: compactJson({ retryAgentRunId: retry.id, reason: input.reason }),
  });
  await store.appendRunEvent({
    agentRunId: retry.id,
    type: "run.retry.source",
    payload: compactJson({ sourceAgentRunId: source.id, reason: input.reason }),
  });

  return retry;
}

function approvalsFromEvents(events: NativeAgentRunEvent[]): NativeAgentApproval[] {
  const approvals = new Map<string, NativeAgentApproval>();
  for (const event of events) {
    if (event.type === "run.approval.requested") {
      const id = stringJson(event.payload.approvalId);
      if (!id) continue;
      approvals.set(id, {
        id,
        agentRunId: event.agentRunId,
        status: "pending",
        title: stringJson(event.payload.title) ?? "Approval requested",
        message: stringJson(event.payload.message) ?? "Native agent approval requested.",
        risk: nativeRisk(event.payload.risk),
        request: objectJson(event.payload.request) ?? {},
        requestedBy: stringJson(event.payload.requestedBy),
        response: {},
        requestedAt: event.createdAt,
      });
      continue;
    }

    if (event.type === "run.approval.resolved") {
      const id = stringJson(event.payload.approvalId);
      if (!id) continue;
      const existing = approvals.get(id);
      if (!existing) continue;
      approvals.set(id, {
        ...existing,
        status: approvalDecision(event.payload.decision),
        response: objectJson(event.payload.response) ?? {},
        resolvedBy: stringJson(event.payload.resolvedBy),
        resolvedAt: event.createdAt,
      });
    }
  }
  return Array.from(approvals.values()).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

async function readAllRunEvents(store: NativeAgentStore, agentRunId: string): Promise<NativeAgentRunEvent[]> {
  const events: NativeAgentRunEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await store.readRunEvents({ agentRunId, afterSeq, maxEvents: 500 });
    events.push(...page);
    if (page.length < 500) return events;
    afterSeq = page[page.length - 1]!.seq;
  }
}

async function requireRun(store: NativeAgentStore, agentRunId: string): Promise<NativeAgentRun> {
  const run = await store.getAgentRun(agentRunId);
  if (!run) throw new NativeAgentOperatorError(404, "AGENT_RUN_NOT_FOUND", "Native agent run was not found.", false);
  return run;
}

function compactJson(value: Record<string, JsonValue | undefined>): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function stringJson(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectJson(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function nativeRisk(value: JsonValue | undefined): NativeAgentToolRisk {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function approvalDecision(value: JsonValue | undefined): NativeAgentApprovalDecision {
  return value === "denied" ? "denied" : "approved";
}
