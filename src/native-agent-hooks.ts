import type { JsonObject } from "./postgres-automation-store.js";
import type {
  NativeAgentStore,
  NativeRuntimeHookDecision,
  NativeRuntimeHookEventName,
} from "./native-agent-store.js";

export interface NativeRuntimeHookInput {
  agentRunId?: string;
  hookEventName: NativeRuntimeHookEventName;
  payload?: JsonObject;
}

export interface NativeRuntimeHookResult {
  decision: NativeRuntimeHookDecision;
  continue: boolean;
  reason?: string;
  auditOnly: boolean;
  additionalContext?: string;
}

export type NativeRuntimeHookHandler = (
  input: NativeRuntimeHookInput,
) => Promise<NativeRuntimeHookResult> | NativeRuntimeHookResult;

export class NativeRuntimeHookManager {
  private readonly handlers = new Map<NativeRuntimeHookEventName, NativeRuntimeHookHandler[]>();

  register(eventName: NativeRuntimeHookEventName, handler: NativeRuntimeHookHandler): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  async run(store: NativeAgentStore, input: NativeRuntimeHookInput): Promise<NativeRuntimeHookResult> {
    const handlers = this.handlers.get(input.hookEventName) ?? [];
    let finalResult: NativeRuntimeHookResult = {
      decision: "audit_only",
      continue: true,
      auditOnly: true,
    };

    for (const handler of handlers) {
      const result = await handler(input);
      finalResult = mergeHookResults(finalResult, result);
      await store.recordRuntimeHook({
        agentRunId: input.agentRunId,
        hookEventName: input.hookEventName,
        decision: result.decision,
        payload: input.payload,
        result: hookResultJson(result),
      });
      if (!result.continue) return result;
    }

    if (handlers.length === 0) {
      await store.recordRuntimeHook({
        agentRunId: input.agentRunId,
        hookEventName: input.hookEventName,
        decision: finalResult.decision,
        payload: input.payload,
        result: hookResultJson(finalResult),
      });
    }

    return finalResult;
  }
}

export function defaultNativeRuntimeHooks(): NativeRuntimeHookManager {
  const manager = new NativeRuntimeHookManager();
  manager.register("PreToolUse", (input) => {
    const policyDecision = stringPayload(input.payload?.decision);
    if (policyDecision === "block") {
      return {
        decision: "block",
        continue: false,
        auditOnly: false,
        reason: "Tool use was blocked by native policy.",
      };
    }
    if (policyDecision === "audit_only") {
      return {
        decision: "audit_only",
        continue: true,
        auditOnly: true,
        reason: "Tool use is allowed only with an audit record by native policy.",
      };
    }

    const risk = input.payload?.risk;
    if (risk === "high") {
      return {
        decision: "ask",
        continue: true,
        auditOnly: false,
        reason: "High-risk tool use requires explicit native policy approval.",
      };
    }
    return {
      decision: "allow",
      continue: true,
      auditOnly: false,
      reason: "Tool use passed default native hook policy.",
    };
  });
  manager.register("PermissionRequest", (input) => {
    if (input.payload?.decision === "block") {
      return {
        decision: "deny",
        continue: false,
        auditOnly: false,
        reason: "Permission request was blocked by native policy.",
      };
    }
    return {
      decision: "allow",
      continue: true,
      auditOnly: false,
      reason: "Permission request allowed by default native hook policy.",
    };
  });
  manager.register("Stop", () => ({
    decision: "audit_only",
    continue: true,
    auditOnly: true,
    reason: "Native agent run stopped; final state recorded for audit.",
  }));
  return manager;
}

function mergeHookResults(
  previous: NativeRuntimeHookResult,
  next: NativeRuntimeHookResult,
): NativeRuntimeHookResult {
  if (!next.continue) return next;
  if (previous.decision === "block" || previous.decision === "deny") return previous;
  if (next.decision === "ask" || next.decision === "block" || next.decision === "deny") return next;
  return next;
}

function hookResultJson(result: NativeRuntimeHookResult): JsonObject {
  return {
    decision: result.decision,
    continue: result.continue,
    auditOnly: result.auditOnly,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
  };
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
