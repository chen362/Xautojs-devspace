import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  isTerminalNativeAgentRunStatus,
  type NativeAgentPermissionProfile,
  type NativeAgentRun,
  type NativeAgentStore,
  PostgresNativeAgentStore,
} from "./native-agent-store.js";
import { NativeProcessManager } from "./native-agent-process.js";
import { evaluateNativeCommandPolicy, type NativePolicyResult } from "./native-agent-policy.js";
import { defaultNativeRuntimeHooks, type NativeRuntimeHookManager, type NativeRuntimeHookResult } from "./native-agent-hooks.js";
import { ensureNativeAgentPolicyApproval, type NativeAgentApproval } from "./native-agent-operator.js";
import { buildNativeWorkflowExecution, workflowInputFromAgentInput } from "./native-agent-workflows.js";
import type { NativeWorkflowExecution } from "./native-agent-workflows.js";
import type { JsonObject, JsonValue } from "./postgres-automation-store.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

export interface NativeAgentDispatchResult {
  claimed: boolean;
  agentRun?: NativeAgentRun;
  status: "idle" | "waiting_input" | "succeeded" | "failed" | "cancelled" | "timed_out";
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeAgentDispatchOptions {
  automationRunId?: string;
  workspaceRoot?: string;
  workflowId?: string;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
}

export interface NativeAgentRunDispatchOptions {
  agentRunId: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
}

export interface NativeAgentRuntimeDependencies {
  store: NativeAgentStore;
  workspaceStore?: WorkspaceStore;
  processManager?: NativeProcessManager;
  hooks?: NativeRuntimeHookManager;
  now?: () => Date;
}

export async function dispatchNativeAgentOnce(
  config: ServerConfig,
  options: NativeAgentDispatchOptions = {},
  dependencies?: Partial<NativeAgentRuntimeDependencies>,
): Promise<NativeAgentDispatchResult> {
  return withNativeRuntime(config, dependencies, async ({ store, workspaceStore, processManager, hooks, now }) => {
    const claimed = await store.claimAutomationRun({
      automationRunId: options.automationRunId,
      workflowId: options.workflowId,
    });
    if (!claimed) return { claimed: false, status: "idle" };

    return executeNativeAgentRun(config, claimed, {
      store,
      workspaceStore,
      processManager,
      hooks,
      now,
      workspaceRoot: options.workspaceRoot,
      workflowId: options.workflowId,
      timeoutMs: options.timeoutMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
      source: "automation",
    });
  });
}

export async function dispatchNativeAgentRunOnce(
  config: ServerConfig,
  options: NativeAgentRunDispatchOptions,
  dependencies?: Partial<NativeAgentRuntimeDependencies>,
): Promise<NativeAgentDispatchResult> {
  return withNativeRuntime(config, dependencies, async ({ store, workspaceStore, processManager, hooks, now }) => {
    const run = await store.getAgentRun(options.agentRunId);
    if (!run || isTerminalNativeAgentRunStatus(run.status)) {
      return { claimed: false, status: "idle", agentRun: run };
    }

    return executeNativeAgentRun(config, run, {
      store,
      workspaceStore,
      processManager,
      hooks,
      now,
      workspaceRoot: options.workspaceRoot,
      workflowId: run.workflowId,
      timeoutMs: options.timeoutMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
      source: "native_run",
    });
  });
}

async function executeNativeAgentRun(
  config: ServerConfig,
  run: NativeAgentRun,
  input: {
    store: NativeAgentStore;
    workspaceStore: WorkspaceStore;
    processManager: NativeProcessManager;
    hooks: NativeRuntimeHookManager;
    now: () => Date;
    workspaceRoot?: string;
    workflowId?: string;
    timeoutMs?: number;
    approvalTimeoutMs?: number;
    source: "automation" | "native_run";
  },
): Promise<NativeAgentDispatchResult> {
  const { store, workspaceStore, processManager, hooks } = input;
  let activeRun = run;
  if (activeRun.status === "queued" || activeRun.status === "claiming") {
    activeRun = await store.setAgentRunStatus({ agentRunId: activeRun.id, status: "running" }) ?? activeRun;
  }

  await store.appendRunEvent({
    agentRunId: activeRun.id,
    type: "run.started",
    payload: {
      source: input.source,
      workflowId: input.workflowId ?? activeRun.workflowId,
      automationRunId: activeRun.automationRunId ?? null,
    },
  });

  const workspaceRoot = await resolveDispatchWorkspaceRoot(config, activeRun, workspaceStore, input.workspaceRoot);
  if (!workspaceRoot) {
    return failRun(store, activeRun, "WORKSPACE_REQUIRED", "Native agent dispatch requires a workspace session or --workspace-root.");
  }

  const workflowInput = workflowInputFromAgentInput({
    ...activeRun.input,
    workflowId: input.workflowId ?? activeRun.workflowId,
  });
  const execution = buildNativeWorkflowExecution(workflowInput);
  await appendLoopPlan(store, activeRun, execution);

  const permissionProfile = effectivePermissionProfile(activeRun.permissionProfile, execution.permissionProfile);
  const policy = evaluateNativeCommandPolicy({
    permissionProfile,
    argv: execution.argv,
    cwd: workspaceRoot,
    workspaceRoot,
    internal: true,
  });

  const preToolUse = await hooks.run(store, {
    agentRunId: activeRun.id,
    hookEventName: "PreToolUse",
    payload: {
      toolName: "process",
      workflowId: execution.workflow.id,
      permissionProfile,
      risk: policy.risk,
      decision: policy.decision,
      reason: policy.reason,
    },
  });

  if (policy.decision === "block" || !preToolUse.continue || preToolUse.decision === "block" || preToolUse.decision === "deny") {
    await blockProcessTool(store, activeRun, execution, workspaceRoot, policy, preToolUse.reason ?? policy.reason);
    return failRun(store, activeRun, "NATIVE_POLICY_BLOCKED", preToolUse.reason ?? policy.reason);
  }

  if (policy.decision === "ask" || preToolUse.decision === "ask") {
    const gate = await resolveApprovalGate(store, activeRun, execution, workspaceRoot, policy, preToolUse, input);
    if (gate.status !== "approved") return gate.result;
    activeRun = gate.agentRun;
  }

  const toolCall = await store.recordToolCallStart({
    agentRunId: activeRun.id,
    toolName: "process",
    risk: policy.risk,
    input: { argv: execution.argv, cwd: workspaceRoot, workflowId: execution.workflow.id },
  });
  const processId = `${activeRun.id}_process`;
  processManager.start({
    processId,
    argv: execution.argv,
    cwd: workspaceRoot,
    env: execution.env,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: 2 * 1024 * 1024,
  });

  let afterSeq = 0;
  for (;;) {
    const read = await processManager.read({ processId, afterSeq, waitMs: 100, maxBytes: 128 * 1024 });
    for (const chunk of read.chunks) {
      afterSeq = Math.max(afterSeq, chunk.seq);
      await store.appendRunEvent({
        agentRunId: activeRun.id,
        type: "run.output_delta",
        payload: {
          processId,
          seq: chunk.seq,
          stream: chunk.stream,
          text: chunk.text,
        },
      });
    }

    if (read.exited) {
      if (read.status === "timed_out") {
        await store.finishToolCall({
          id: toolCall.id,
          status: "failed",
          errorCode: "PROCESS_TIMED_OUT",
          errorMessage: read.failure ?? "Native process timed out.",
        });
        return failRun(store, activeRun, "PROCESS_TIMED_OUT", read.failure ?? "Native process timed out.", "timed_out");
      }
      if (read.status === "cancelled") {
        await store.finishToolCall({
          id: toolCall.id,
          status: "failed",
          errorCode: "PROCESS_CANCELLED",
          errorMessage: read.failure ?? "Native process cancelled.",
        });
        return failRun(store, activeRun, "PROCESS_CANCELLED", read.failure ?? "Native process cancelled.", "cancelled");
      }
      if (read.failure || (read.exitCode ?? 0) !== 0) {
        await store.finishToolCall({
          id: toolCall.id,
          status: "failed",
          errorCode: "PROCESS_FAILED",
          errorMessage: read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`,
        });
        return failRun(store, activeRun, "PROCESS_FAILED", read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`);
      }
      break;
    }
  }

  await store.finishToolCall({
    id: toolCall.id,
    status: "succeeded",
    result: { processId, workflowId: execution.workflow.id },
  });
  await hooks.run(store, {
    agentRunId: activeRun.id,
    hookEventName: "PostToolUse",
    payload: {
      toolName: "process",
      toolCallId: toolCall.id,
      workflowId: execution.workflow.id,
      status: "succeeded",
    },
  });
  await store.appendRunEvent({
    agentRunId: activeRun.id,
    type: "run.loop.completed",
    payload: { workflowId: execution.workflow.id, stepCount: execution.steps.length },
  });
  await hooks.run(store, {
    agentRunId: activeRun.id,
    hookEventName: "Stop",
    payload: { status: "succeeded" },
  });
  await store.appendRunEvent({
    agentRunId: activeRun.id,
    type: "run.succeeded",
    payload: { workflowId: execution.workflow.id },
  });
  const finished = await store.finishAgentRun({
    agentRunId: activeRun.id,
    status: "succeeded",
    result: {
      workflowId: execution.workflow.id,
      prompt: execution.prompt,
      steps: workflowStepsJson(execution),
    },
  });
  return { claimed: true, status: "succeeded", agentRun: finished ?? activeRun };
}

async function withNativeRuntime<T>(
  config: ServerConfig,
  dependencies: Partial<NativeAgentRuntimeDependencies> | undefined,
  fn: (runtime: {
    store: NativeAgentStore;
    workspaceStore: WorkspaceStore;
    processManager: NativeProcessManager;
    hooks: NativeRuntimeHookManager;
    now: () => Date;
  }) => Promise<T>,
): Promise<T> {
  const store = dependencies?.store ?? (
    config.database.provider === "postgres" ? new PostgresNativeAgentStore(config.database) : undefined
  );
  if (!store) throw new Error("Native agent dispatch requires DEVSPACE_DATABASE_PROVIDER=postgres.");

  const workspaceStore = dependencies?.workspaceStore ?? createWorkspaceStore(config.database);
  const processManager = dependencies?.processManager ?? new NativeProcessManager();
  const hooks = dependencies?.hooks ?? defaultNativeRuntimeHooks();
  const now = dependencies?.now ?? (() => new Date());
  const ownsStore = !dependencies?.store;
  const ownsWorkspaceStore = !dependencies?.workspaceStore;
  const ownsProcessManager = !dependencies?.processManager;

  try {
    return await fn({ store, workspaceStore, processManager, hooks, now });
  } finally {
    if (ownsProcessManager) processManager.close();
    if (ownsWorkspaceStore) await workspaceStore.close?.();
    if (ownsStore) await store.close?.();
  }
}

async function resolveApprovalGate(
  store: NativeAgentStore,
  run: NativeAgentRun,
  execution: NativeWorkflowExecution,
  workspaceRoot: string,
  policy: NativePolicyResult,
  preToolUse: NativeRuntimeHookResult,
  input: {
    hooks: NativeRuntimeHookManager;
    now: () => Date;
    approvalTimeoutMs?: number;
  },
): Promise<
  | { status: "approved"; agentRun: NativeAgentRun }
  | { status: "pending" | "denied" | "timed_out"; result: NativeAgentDispatchResult }
> {
  const permissionRequest = await input.hooks.run(store, {
    agentRunId: run.id,
    hookEventName: "PermissionRequest",
    payload: {
      toolName: "process",
      workflowId: execution.workflow.id,
      risk: policy.risk,
      decision: policy.decision,
      reason: preToolUse.reason ?? policy.reason,
    },
  });
  if (!permissionRequest.continue || permissionRequest.decision === "deny" || permissionRequest.decision === "block") {
    return {
      status: "denied",
      result: await failRun(
        store,
        run,
        "NATIVE_APPROVAL_DENIED",
        permissionRequest.reason ?? "Native policy approval request was denied.",
      ),
    };
  }

  const approval = await ensureNativeAgentPolicyApproval(store, {
    agentRunId: run.id,
    title: policy.approvalTitle ?? "Approve native process execution",
    message: policy.approvalMessage ?? preToolUse.reason ?? policy.reason,
    risk: policy.risk,
    request: {
      toolName: "process",
      workflowId: execution.workflow.id,
      argv: execution.argv,
      cwd: workspaceRoot,
      policyDecision: policy.decision,
      policyReason: policy.reason,
      hookDecision: preToolUse.decision,
      hookReason: preToolUse.reason ?? null,
    },
    requestedBy: "native-runtime",
    timeoutMs: input.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    now: input.now,
  });

  if (approval.status === "pending") {
    return {
      status: "pending",
      result: await waitForApproval(store, run, approval),
    };
  }

  if (approval.status === "denied") {
    const code = approvalDeniedCode(approval);
    return {
      status: code === "NATIVE_APPROVAL_TIMEOUT" ? "timed_out" : "denied",
      result: await failRun(
        store,
        run,
        code,
        stringJson(approval.response.message) ?? (code === "NATIVE_APPROVAL_TIMEOUT" ? "Native agent approval timed out." : "Native agent approval was denied."),
        code === "NATIVE_APPROVAL_TIMEOUT" ? "timed_out" : "failed",
      ),
    };
  }

  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.approval.accepted",
    payload: { approvalId: approval.id, resolvedBy: approval.resolvedBy ?? null },
  });
  const resumed = await store.setAgentRunStatus({
    agentRunId: run.id,
    status: "running",
    result: { approvalId: approval.id, approvalStatus: "approved" },
  });
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.resumed",
    payload: { approvalId: approval.id },
  });
  return { status: "approved", agentRun: resumed ?? run };
}

async function waitForApproval(
  store: NativeAgentStore,
  run: NativeAgentRun,
  approval: NativeAgentApproval,
): Promise<NativeAgentDispatchResult> {
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.waiting_input",
    payload: {
      approvalId: approval.id,
      title: approval.title,
      risk: approval.risk,
      expiresAt: approval.expiresAt ?? null,
      reason: approval.message,
    },
  });
  const waiting = await store.setAgentRunStatus({
    agentRunId: run.id,
    status: "waiting_input",
    result: { approvalId: approval.id, approvalStatus: "pending" },
    errorCode: "NATIVE_APPROVAL_REQUIRED",
    errorMessage: approval.message,
  });
  return {
    claimed: true,
    status: "waiting_input",
    agentRun: waiting ?? run,
    errorCode: "NATIVE_APPROVAL_REQUIRED",
    errorMessage: approval.message,
  };
}

async function blockProcessTool(
  store: NativeAgentStore,
  run: NativeAgentRun,
  execution: NativeWorkflowExecution,
  workspaceRoot: string,
  policy: NativePolicyResult,
  errorMessage: string,
): Promise<void> {
  await store.recordToolCallStart({
    agentRunId: run.id,
    toolName: "process",
    risk: policy.risk,
    input: { argv: execution.argv, cwd: workspaceRoot },
  }).then((call) => store.finishToolCall({
    id: call.id,
    status: "blocked",
    errorCode: "NATIVE_POLICY_BLOCKED",
    errorMessage,
  }));
}

async function appendLoopPlan(
  store: NativeAgentStore,
  run: NativeAgentRun,
  execution: NativeWorkflowExecution,
): Promise<void> {
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.loop.started",
    payload: {
      workflowId: execution.workflow.id,
      title: execution.workflow.title,
      stepCount: execution.steps.length,
    },
  });
  for (const [index, step] of execution.steps.entries()) {
    await store.appendRunEvent({
      agentRunId: run.id,
      type: "run.loop.step",
      payload: {
        index: index + 1,
        id: step.id,
        title: step.title,
        objective: step.objective,
      },
    });
  }
}

async function resolveDispatchWorkspaceRoot(
  config: ServerConfig,
  run: NativeAgentRun,
  workspaceStore: WorkspaceStore,
  workspaceRoot: string | undefined,
): Promise<string | undefined> {
  if (workspaceRoot) return assertAllowedPath(workspaceRoot, config.allowedRoots);
  if (!run.workspaceSessionId) return undefined;

  const session = await workspaceStore.getSession(run.workspaceSessionId, {
    tenantId: run.tenantId,
    userId: run.userId,
  });
  if (!session) return undefined;
  return assertAllowedPath(resolve(session.root), session.mode === "worktree" ? [config.worktreeRoot] : config.allowedRoots);
}

async function failRun(
  store: NativeAgentStore,
  run: NativeAgentRun,
  errorCode: string,
  errorMessage: string,
  status: "failed" | "cancelled" | "timed_out" = "failed",
): Promise<NativeAgentDispatchResult> {
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.loop.failed",
    payload: { errorCode, errorMessage },
  });
  await store.appendRunEvent({
    agentRunId: run.id,
    type: status === "timed_out" ? "run.timed_out" : status === "cancelled" ? "run.cancelled" : "run.failed",
    payload: { errorCode, errorMessage },
  });
  const finished = await store.finishAgentRun({
    agentRunId: run.id,
    status,
    errorCode,
    errorMessage,
  });
  return {
    claimed: true,
    status,
    agentRun: finished ?? run,
    errorCode,
    errorMessage,
  };
}

function workflowStepsJson(execution: NativeWorkflowExecution) {
  return execution.steps.map((step) => ({
    id: step.id,
    title: step.title,
    objective: step.objective,
  }));
}

function effectivePermissionProfile(
  runProfile: NativeAgentPermissionProfile,
  workflowProfile: NativeAgentPermissionProfile,
): NativeAgentPermissionProfile {
  if (runProfile === "read_only" || workflowProfile === "read_only") return "read_only";
  if (runProfile === "workspace_write" || workflowProfile === "workspace_write") return "workspace_write";
  return "trusted_local";
}

function approvalDeniedCode(approval: NativeAgentApproval): string {
  return stringJson(approval.response.code) === "NATIVE_APPROVAL_TIMEOUT"
    ? "NATIVE_APPROVAL_TIMEOUT"
    : "NATIVE_APPROVAL_DENIED";
}

function stringJson(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
