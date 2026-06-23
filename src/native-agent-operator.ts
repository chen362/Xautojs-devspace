import { createHash, randomUUID } from "node:crypto";
import {
  isTerminalNativeAgentRunStatus,
  type NativeAgentPermissionProfile,
  type NativeAgentRun,
  type NativeAgentRunEvent,
  type NativeAgentRunStatus,
  type NativeAgentStore,
  type NativeAgentToolRisk,
  type NativeRuntimeHookDecision,
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
  expiresAt?: string;
}

export interface NativeAgentReplayHookDecision {
  seq: number;
  eventName: string;
  decision: NativeRuntimeHookDecision;
  continue: boolean;
  auditOnly: boolean;
  blocking: boolean;
  createdAt: string;
  stage?: string;
  workflowId?: string;
  stepId?: string;
  stepPhase?: string;
  toolName?: string;
  risk?: NativeAgentToolRisk;
  ruleId?: string;
  reason?: string;
}

export interface NativeAgentReplayWorkflowStep {
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
  hookDecision?: NativeRuntimeHookDecision;
  hookRuleId?: string;
  hookReason?: string;
  hookContinue?: boolean;
  hookCreatedAt?: string;
}

export interface NativeAgentReplaySummary {
  agentRunId: string;
  workflowId: string;
  status: NativeAgentRunStatus;
  attempt: number;
  permissionProfile: NativeAgentPermissionProfile;
  terminal: boolean;
  eventCount: number;
  nextSeq: number;
  approvals: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
    latestPending?: NativeAgentApproval;
  };
  hooks: {
    total: number;
    allow: number;
    ask: number;
    block: number;
    deny: number;
    auditOnly: number;
    blocking: NativeAgentReplayHookDecision[];
    latest: NativeAgentReplayHookDecision[];
  };
  workflowSteps: NativeAgentReplayWorkflowStep[];
  retries: {
    retryOfAgentRunId?: string;
    retryAgentRunIds: string[];
  };
}

export interface NativeAgentReplay {
  agentRunId: string;
  events: NativeAgentRunEvent[];
  approvals: NativeAgentApproval[];
  summary: NativeAgentReplaySummary;
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
    expiresAt?: string;
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
      expiresAt: input.expiresAt,
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
    expiresAt: input.expiresAt,
  };
}

export async function ensureNativeAgentPolicyApproval(
  store: NativeAgentStore,
  input: {
    agentRunId: string;
    title: string;
    message: string;
    risk: NativeAgentToolRisk;
    request: JsonObject;
    requestedBy?: string;
    approvalId?: string;
    timeoutMs?: number;
    now?: () => Date;
  },
): Promise<NativeAgentApproval> {
  await requireRun(store, input.agentRunId);
  const now = input.now?.() ?? new Date();
  const fingerprint = approvalFingerprint({
    title: input.title,
    message: input.message,
    risk: input.risk,
    request: input.request,
  });
  const request = {
    ...input.request,
    approvalFingerprint: fingerprint,
  };
  const existing = (await listNativeAgentApprovals(store, { agentRunId: input.agentRunId }))
    .reverse()
    .find((approval) => stringJson(approval.request.approvalFingerprint) === fingerprint);

  if (existing) {
    if (existing.status === "pending" && approvalExpired(existing, now)) {
      return expireNativeAgentApproval(store, existing, now);
    }
    return existing;
  }

  return requestNativeAgentApproval(store, {
    agentRunId: input.agentRunId,
    approvalId: input.approvalId,
    title: input.title,
    message: input.message,
    risk: input.risk,
    request,
    requestedBy: input.requestedBy,
    expiresAt: input.timeoutMs && input.timeoutMs > 0 ? new Date(now.getTime() + input.timeoutMs).toISOString() : undefined,
  });
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
  const approvals = approvalsFromEvents(events);
  const nextSeq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 1;
  const terminal = isTerminalNativeAgentRunStatus(run.status);
  return {
    agentRunId: input.agentRunId,
    events,
    approvals,
    summary: replaySummary(run, events, approvals, nextSeq, terminal),
    nextSeq,
    terminal,
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

function replaySummary(
  run: NativeAgentRun,
  events: NativeAgentRunEvent[],
  approvals: NativeAgentApproval[],
  nextSeq: number,
  terminal: boolean,
): NativeAgentReplaySummary {
  const hooks = hookDecisionsFromEvents(events);
  const approvalSummary = approvalCounts(approvals);
  return {
    agentRunId: run.id,
    workflowId: run.workflowId,
    status: run.status,
    attempt: run.attempt,
    permissionProfile: run.permissionProfile,
    terminal,
    eventCount: events.length,
    nextSeq,
    approvals: approvalSummary,
    hooks: hookSummary(hooks),
    workflowSteps: workflowStepsFromEvents(events, hooks),
    retries: retrySummary(events),
  };
}

function approvalCounts(approvals: NativeAgentApproval[]): NativeAgentReplaySummary["approvals"] {
  const pending = approvals.filter((approval) => approval.status === "pending");
  return {
    total: approvals.length,
    pending: pending.length,
    approved: approvals.filter((approval) => approval.status === "approved").length,
    denied: approvals.filter((approval) => approval.status === "denied").length,
    latestPending: pending.at(-1),
  };
}

function hookSummary(hooks: NativeAgentReplayHookDecision[]): NativeAgentReplaySummary["hooks"] {
  return {
    total: hooks.length,
    allow: hooks.filter((hook) => hook.decision === "allow").length,
    ask: hooks.filter((hook) => hook.decision === "ask").length,
    block: hooks.filter((hook) => hook.decision === "block").length,
    deny: hooks.filter((hook) => hook.decision === "deny").length,
    auditOnly: hooks.filter((hook) => hook.decision === "audit_only").length,
    blocking: hooks.filter((hook) => hook.blocking),
    latest: hooks.slice(-10),
  };
}

function workflowStepsFromEvents(
  events: NativeAgentRunEvent[],
  hooks: NativeAgentReplayHookDecision[],
): NativeAgentReplayWorkflowStep[] {
  const workflowStepHooks = new Map<string, NativeAgentReplayHookDecision>();
  for (const hook of hooks) {
    if (hook.eventName !== "WorkflowStep" || !hook.stepId) continue;
    workflowStepHooks.set(hook.stepId, hook);
  }

  return events
    .filter((event) => event.type === "run.loop.step")
    .map((event) => {
      const id = stringJson(event.payload.id) ?? `step-${event.seq}`;
      const hook = workflowStepHooks.get(id);
      return {
        seq: event.seq,
        id,
        title: stringJson(event.payload.title),
        phase: stringJson(event.payload.phase),
        action: stringJson(event.payload.action),
        expectedOutput: stringJson(event.payload.expectedOutput),
        acceptanceCriteria: stringArrayJson(event.payload.acceptanceCriteria),
        suggestedTools: stringArrayJson(event.payload.suggestedTools),
        createdAt: event.createdAt,
        status: hook?.blocking ? "blocked" : "recorded",
        hookDecision: hook?.decision,
        hookRuleId: hook?.ruleId,
        hookReason: hook?.reason,
        hookContinue: hook?.continue,
        hookCreatedAt: hook?.createdAt,
      };
    });
}

function hookDecisionsFromEvents(events: NativeAgentRunEvent[]): NativeAgentReplayHookDecision[] {
  return events
    .filter((event) => event.type === "run.hook.decision")
    .map((event) => {
      const hookPayload = objectJson(event.payload.hookPayload) ?? {};
      const decision = nativeHookDecision(event.payload.decision);
      const continueValue = booleanJson(event.payload.continue) ?? true;
      return {
        seq: event.seq,
        eventName: stringJson(event.payload.hookEventName) ?? "unknown",
        decision,
        continue: continueValue,
        auditOnly: booleanJson(event.payload.auditOnly) ?? decision === "audit_only",
        blocking: !continueValue || decision === "block" || decision === "deny",
        createdAt: event.createdAt,
        stage: stringJson(hookPayload.stage),
        workflowId: stringJson(hookPayload.workflowId),
        stepId: stringJson(hookPayload.stepId ?? hookPayload.id),
        stepPhase: stringJson(hookPayload.stepPhase ?? hookPayload.phase),
        toolName: stringJson(hookPayload.toolName),
        risk: nativeRiskOrUndefined(hookPayload.risk),
        ruleId: stringJson(event.payload.ruleId),
        reason: stringJson(event.payload.reason),
      };
    });
}

function retrySummary(events: NativeAgentRunEvent[]): NativeAgentReplaySummary["retries"] {
  return {
    retryOfAgentRunId: events
      .filter((event) => event.type === "run.retry.source")
      .map((event) => stringJson(event.payload.sourceAgentRunId))
      .find(Boolean),
    retryAgentRunIds: events
      .filter((event) => event.type === "run.retry.created")
      .map((event) => stringJson(event.payload.retryAgentRunId))
      .filter((value): value is string => Boolean(value)),
  };
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
        expiresAt: stringJson(event.payload.expiresAt),
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

async function expireNativeAgentApproval(
  store: NativeAgentStore,
  approval: NativeAgentApproval,
  now: Date,
): Promise<NativeAgentApproval> {
  return resolveNativeAgentApproval(store, {
    agentRunId: approval.agentRunId,
    approvalId: approval.id,
    decision: "denied",
    response: {
      code: "NATIVE_APPROVAL_TIMEOUT",
      message: "Native agent approval timed out.",
      expiredAt: now.toISOString(),
    },
    resolvedBy: "system:timeout",
  });
}

function approvalExpired(approval: NativeAgentApproval, now: Date): boolean {
  if (!approval.expiresAt) return false;
  return Date.parse(approval.expiresAt) <= now.getTime();
}

function approvalFingerprint(value: JsonObject): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
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

function booleanJson(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayJson(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

function objectJson(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function nativeRisk(value: JsonValue | undefined): NativeAgentToolRisk {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function nativeRiskOrUndefined(value: JsonValue | undefined): NativeAgentToolRisk | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function nativeHookDecision(value: JsonValue | undefined): NativeRuntimeHookDecision {
  if (value === "allow" || value === "block" || value === "ask" || value === "deny" || value === "audit_only") return value;
  return "audit_only";
}

function approvalDecision(value: JsonValue | undefined): NativeAgentApprovalDecision {
  return value === "denied" ? "denied" : "approved";
}
