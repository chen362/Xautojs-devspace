import { resolve } from "node:path";
import { assertAllowedPath } from "./roots.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { createWorkspaceStore } from "./workspace-store.js";
import {
  type NativeAgentRun,
  type NativeAgentStore,
  PostgresNativeAgentStore,
} from "./native-agent-store.js";
import { NativeProcessManager } from "./native-agent-process.js";
import { evaluateNativeCommandPolicy } from "./native-agent-policy.js";
import { defaultNativeRuntimeHooks, type NativeRuntimeHookManager } from "./native-agent-hooks.js";
import { buildNativeWorkflowExecution, workflowInputFromAgentInput } from "./native-agent-workflows.js";

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
  if (config.database.provider !== "postgres" && !dependencies?.store) {
    throw new Error("Native agent dispatch requires DEVSPACE_DATABASE_PROVIDER=postgres.");
  }

  const store = dependencies?.store ?? new PostgresNativeAgentStore(config.database);
  const workspaceStore = dependencies?.workspaceStore ?? createWorkspaceStore(config.database);
  const processManager = dependencies?.processManager ?? new NativeProcessManager();
  const hooks = dependencies?.hooks ?? defaultNativeRuntimeHooks();
  const ownsStore = !dependencies?.store;
  const ownsWorkspaceStore = !dependencies?.workspaceStore;
  const ownsProcessManager = !dependencies?.processManager;

  try {
    const claimed = await store.claimAutomationRun({
      automationRunId: options.automationRunId,
      workflowId: options.workflowId,
    });
    if (!claimed) return { claimed: false, status: "idle" };

    await store.appendRunEvent({
      agentRunId: claimed.id,
      type: "run.started",
      payload: { workflowId: claimed.workflowId, automationRunId: claimed.automationRunId ?? null },
    });

    const workspaceRoot = await resolveDispatchWorkspaceRoot(config, claimed, workspaceStore, options.workspaceRoot);
    if (!workspaceRoot) {
      return failRun(store, claimed, "WORKSPACE_REQUIRED", "Native agent dispatch requires a workspace session or --workspace-root.");
    }

    const workflowInput = workflowInputFromAgentInput({
      ...claimed.input,
      workflowId: options.workflowId ?? claimed.workflowId,
    });
    const execution = buildNativeWorkflowExecution(workflowInput);
    const policy = evaluateNativeCommandPolicy({
      permissionProfile: claimed.permissionProfile,
      argv: execution.argv,
      cwd: workspaceRoot,
      workspaceRoot,
      internal: true,
    });

    await hooks.run(store, {
      agentRunId: claimed.id,
      hookEventName: "PreToolUse",
      payload: {
        toolName: "process",
        risk: policy.risk,
        decision: policy.decision,
        reason: policy.reason,
      },
    });

    if (policy.decision === "block") {
      await store.recordToolCallStart({
        agentRunId: claimed.id,
        toolName: "process",
        risk: policy.risk,
        input: { argv: execution.argv, cwd: workspaceRoot },
      }).then((call) => store.finishToolCall({
        id: call.id,
        status: "blocked",
        errorCode: "NATIVE_POLICY_BLOCKED",
        errorMessage: policy.reason,
      }));
      return failRun(store, claimed, "NATIVE_POLICY_BLOCKED", policy.reason);
    }

    const toolCall = await store.recordToolCallStart({
      agentRunId: claimed.id,
      toolName: "process",
      risk: policy.risk,
      input: { argv: execution.argv, cwd: workspaceRoot, workflowId: execution.workflow.id },
    });
    const processId = `${claimed.id}_process`;
    processManager.start({
      processId,
      argv: execution.argv,
      cwd: workspaceRoot,
      env: execution.env,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024,
    });

    let afterSeq = 0;
    for (;;) {
      const read = await processManager.read({ processId, afterSeq, waitMs: 100, maxBytes: 128 * 1024 });
      for (const chunk of read.chunks) {
        afterSeq = Math.max(afterSeq, chunk.seq);
        await store.appendRunEvent({
          agentRunId: claimed.id,
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
          return failRun(store, claimed, "PROCESS_TIMED_OUT", read.failure ?? "Native process timed out.", "timed_out");
        }
        if (read.status === "cancelled") {
          await store.finishToolCall({
            id: toolCall.id,
            status: "failed",
            errorCode: "PROCESS_CANCELLED",
            errorMessage: read.failure ?? "Native process cancelled.",
          });
          return failRun(store, claimed, "PROCESS_CANCELLED", read.failure ?? "Native process cancelled.", "cancelled");
        }
        if (read.failure || (read.exitCode ?? 0) !== 0) {
          await store.finishToolCall({
            id: toolCall.id,
            status: "failed",
            errorCode: "PROCESS_FAILED",
            errorMessage: read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`,
          });
          return failRun(store, claimed, "PROCESS_FAILED", read.failure ?? `Native process exited with code ${read.exitCode ?? "unknown"}.`);
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
      agentRunId: claimed.id,
      hookEventName: "Stop",
      payload: { status: "succeeded" },
    });
    await store.appendRunEvent({
      agentRunId: claimed.id,
      type: "run.succeeded",
      payload: { workflowId: execution.workflow.id },
    });
    const finished = await store.finishAgentRun({
      agentRunId: claimed.id,
      status: "succeeded",
      result: {
        workflowId: execution.workflow.id,
        prompt: execution.prompt,
      },
    });
    return { claimed: true, status: "succeeded", agentRun: finished ?? claimed };
  } finally {
    if (ownsProcessManager) processManager.close();
    if (ownsWorkspaceStore) await workspaceStore.close?.();
    if (ownsStore) await store.close?.();
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
