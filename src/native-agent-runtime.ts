import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  isTerminalNativeAgentRunStatus,
  type NativeAgentRun,
  type NativeAgentStore,
  PostgresNativeAgentStore,
} from "./native-agent-store.js";
import { NativeProcessManager } from "./native-agent-process.js";
import { evaluateNativeCommandPolicy } from "./native-agent-policy.js";
import { defaultNativeRuntimeHooks, type NativeRuntimeHookManager } from "./native-agent-hooks.js";
import { buildNativeWorkflowExecution, workflowInputFromAgentInput } from "./native-agent-workflows.js";
import type { NativeWorkflowExecution } from "./native-agent-workflows.js";

export interface NativeAgentDispatchResult {
  claimed: boolean;
  agentRun?: NativeAgentRun;
  status: "idle" | "succeeded" | "failed" | "cancelled" | "timed_out";
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeAgentDispatchOptions {
  automationRunId?: string;
  workspaceRoot?: string;
  workflowId?: string;
  timeoutMs?: number;
}

export interface NativeAgentRunDispatchOptions {
  agentRunId: string;
  workspaceRoot?: string;
  timeoutMs?: number;
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
  return withNativeRuntime(config, dependencies, async ({ store, workspaceStore, processManager, hooks }) => {
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
      workspaceRoot: options.workspaceRoot,
      workflowId: options.workflowId,
      timeoutMs: options.timeoutMs,
      source: "automation",
    });
  });
}

export async function dispatchNativeAgentRunOnce(
  config: ServerConfig,
  options: NativeAgentRunDispatchOptions,
  dependencies?: Partial<NativeAgentRuntimeDependencies>,
): Promise<NativeAgentDispatchResult> {
  return withNativeRuntime(config, dependencies, async ({ store, workspaceStore, processManager, hooks }) => {
    const run = await store.getAgentRun(options.agentRunId);
    if (!run || isTerminalNativeAgentRunStatus(run.status)) {
      return { claimed: false, status: "idle", agentRun: run };
    }

    return executeNativeAgentRun(config, run, {
      store,
      workspaceStore,
      processManager,
      hooks,
      workspaceRoot: options.workspaceRoot,
      workflowId: run.workflowId,
      timeoutMs: options.timeoutMs,
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
    workspaceRoot?: string;
    workflowId?: string;
    timeoutMs?: number;
    source: "automation" | "native_run";
  },
): Promise<NativeAgentDispatchResult> {
  const { store, workspaceStore, processManager, hooks } = input;
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.started",
    payload: {
      source: input.source,
      workflowId: input.workflowId ?? run.workflowId,
      automationRunId: run.automationRunId ?? null,
    },
  });

  const workspaceRoot = await resolveDispatchWorkspaceRoot(config, run, workspaceStore, input.workspaceRoot);
  if (!workspaceRoot) {
    return failRun(store, run, "WORKSPACE_REQUIRED", "Native agent dispatch requires a workspace session or --workspace-root.");
  }

  const workflowInput = workflowInputFromAgentInput({
    ...run.input,
    workflowId: input.workflowId ?? run.workflowId,
  });
  const execution = buildNativeWorkflowExecution(workflowInput);
  await appendLoopPlan(store, run, execution);

  const policy = evaluateNativeCommandPolicy({
    permissionProfile: execution.permissionProfile,
    argv: execution.argv,
    cwd: workspaceRoot,
    workspaceRoot,
    internal: true,
  });

  const preToolUse = await hooks.run(store, {
    agentRunId: run.id,
    hookEventName: "PreToolUse",
    payload: {
      toolName: "process",
      workflowId: execution.workflow.id,
      permissionProfile: execution.permissionProfile,
      risk: policy.risk,
      decision: policy.decision,
      reason: policy.reason,
    },
  });

  if (policy.decision === "block" || !preToolUse.continue) {
    await store.recordToolCallStart({
      agentRunId: run.id,
      toolName: "process",
      risk: policy.risk,
      input: { argv: execution.argv, cwd: workspaceRoot },
    }).then((call) => store.finishToolCall({
      id: call.id,
      status: "blocked",
      errorCode: "NATIVE_POLICY_BLOCKED",
      errorMessage: preToolUse.reason ?? policy.reason,
    }));
    return failRun(store, run, "NATIVE_POLICY_BLOCKED", preToolUse.reason ?? policy.reason);
  }

  const toolCall = await store.recordToolCallStart({
    agentRunId: run.id,
    toolName: "process",
    risk: policy.risk,
    input: { argv: execution.argv, cwd: workspaceRoot, workflowId: execution.workflow.id },
  });
  const processId = `${run.id}_process`;
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
        agentRunId: run.id,
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
        return failRun(store, run, "PROCESS_TIMED_OUT", read.failure ?? "Native process timed out.", "timed_out");
      }
      if (read.status === "cancelled") {
        await store.finishToolCall({
          id: toolCall.id,
          status: "failed",
          errorCode: "PROCESS_CANCELLED",
          errorMessage: read.failure ?? "Native process cancelled.",
        });
        return failRun(store, run, "PROCESS_CANCELLED", read.failure ?? "Native process cancelled.", "cancelled");
      }
      if (read.failure || (read.exitCode ?? 0) !== 0) {
        await store.finishToolCall({
          id: toolCall.id,
          status: "failed",
          errorCode: "PROCESS_FAILED",
          errorMessage: read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`,
        });
        return failRun(store, run, "PROCESS_FAILED", read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`);
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
    agentRunId: run.id,
    hookEventName: "PostToolUse",
    payload: {
      toolName: "process",
      toolCallId: toolCall.id,
      workflowId: execution.workflow.id,
      status: "succeeded",
    },
  });
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.loop.completed",
    payload: { workflowId: execution.workflow.id, stepCount: execution.steps.length },
  });
  await hooks.run(store, {
    agentRunId: run.id,
    hookEventName: "Stop",
    payload: { status: "succeeded" },
  });
  await store.appendRunEvent({
    agentRunId: run.id,
    type: "run.succeeded",
    payload: { workflowId: execution.workflow.id },
  });
  const finished = await store.finishAgentRun({
    agentRunId: run.id,
    status: "succeeded",
    result: {
      workflowId: execution.workflow.id,
      prompt: execution.prompt,
      steps: execution.steps,
    },
  });
  return { claimed: true, status: "succeeded", agentRun: finished ?? run };
}

async function withNativeRuntime<T>(
  config: ServerConfig,
  dependencies: Partial<NativeAgentRuntimeDependencies> | undefined,
  fn: (runtime: {
    store: NativeAgentStore;
    workspaceStore: WorkspaceStore;
    processManager: NativeProcessManager;
    hooks: NativeRuntimeHookManager;
  }) => Promise<T>,
): Promise<T> {
  const store = dependencies?.store ?? (
    config.database.provider === "postgres" ? new PostgresNativeAgentStore(config.database) : undefined
  );
  if (!store) throw new Error("Native agent dispatch requires DEVSPACE_DATABASE_PROVIDER=postgres.");

  const workspaceStore = dependencies?.workspaceStore ?? createWorkspaceStore(config.database);
  const processManager = dependencies?.processManager ?? new NativeProcessManager();
  const hooks = dependencies?.hooks ?? defaultNativeRuntimeHooks();
  const ownsStore = !dependencies?.store;
  const ownsWorkspaceStore = !dependencies?.workspaceStore;
  const ownsProcessManager = !dependencies?.processManager;

  try {
    return await fn({ store, workspaceStore, processManager, hooks });
  } finally {
    if (ownsProcessManager) processManager.close();
    if (ownsWorkspaceStore) await workspaceStore.close?.();
    if (ownsStore) await store.close?.();
  }
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
