import type { JsonObject } from "./postgres-automation-store.js";
import type {
  NativeAgentStore,
  NativeRuntimeHookDecision,
  NativeRuntimeHookEventName,
} from "./native-agent-store.js";
import {
  loadNativeRuntimeHookConfigFromEnv,
  type NativeRuntimeHookConfig,
  type NativeRuntimeHookName,
  type NativeRuntimeHookRule,
} from "./native-agent-hook-config.js";

export interface NativeRuntimeHookInput {
  agentRunId?: string;
  hookEventName: NativeRuntimeHookName;
  payload?: JsonObject;
}

export interface NativeRuntimeHookResult {
  decision: NativeRuntimeHookDecision;
  continue: boolean;
  reason?: string;
  auditOnly: boolean;
  additionalContext?: string;
  ruleId?: string;
}

export type NativeRuntimeHookHandler = (
  input: NativeRuntimeHookInput,
) => Promise<NativeRuntimeHookResult> | NativeRuntimeHookResult;

export class NativeRuntimeHookManager {
  private readonly handlers = new Map<NativeRuntimeHookName, NativeRuntimeHookHandler[]>();
  private readonly rules: NativeRuntimeHookRule[] = [];

  register(eventName: NativeRuntimeHookName, handler: NativeRuntimeHookHandler): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  registerRule(rule: NativeRuntimeHookRule): void {
    this.rules.push(rule);
  }

  async run(store: NativeAgentStore, input: NativeRuntimeHookInput): Promise<NativeRuntimeHookResult> {
    const handlers = this.handlers.get(input.hookEventName) ?? [];
    let finalResult: NativeRuntimeHookResult = defaultHookResult();
    let observed = false;

    for (const handler of handlers) {
      observed = true;
      const result = await handler(input);
      finalResult = mergeHookResults(finalResult, result);
      await recordHookResult(store, input, result);
      if (!result.continue) return result;
    }

    for (const rule of this.rules) {
      if (!hookRuleMatches(rule, input)) continue;
      observed = true;
      const result = hookRuleResult(rule);
      finalResult = mergeHookResults(finalResult, result);
      await recordHookResult(store, input, result);
      if (!result.continue) return result;
    }

    if (!observed) {
      await recordHookResult(store, input, finalResult);
    }

    return finalResult;
  }
}

export function defaultNativeRuntimeHooks(
  config: NativeRuntimeHookConfig = loadNativeRuntimeHookConfigFromEnv(),
): NativeRuntimeHookManager {
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
  manager.register("Start", () => ({
    decision: "audit_only",
    continue: true,
    auditOnly: true,
    reason: "Native agent run started; workflow execution plan recorded for audit.",
  }));
  manager.register("WorkflowStep", () => ({
    decision: "audit_only",
    continue: true,
    auditOnly: true,
    reason: "Native workflow step recorded for audit.",
  }));
  manager.register("Stop", () => ({
    decision: "audit_only",
    continue: true,
    auditOnly: true,
    reason: "Native agent run stopped; final state recorded for audit.",
  }));

  if (config.enabled) {
    for (const rule of config.rules) manager.registerRule(rule);
  }
  return manager;
}

export function isBlockingNativeRuntimeHookResult(result: NativeRuntimeHookResult): boolean {
  return !result.continue || result.decision === "block" || result.decision === "deny";
}

function hookRuleMatches(rule: NativeRuntimeHookRule, input: NativeRuntimeHookInput): boolean {
  const payload = input.payload ?? {};
  return includes(rule.events, input.hookEventName)
    && includes(rule.stages, stringPayload(payload.stage))
    && includes(rule.workflowIds, stringPayload(payload.workflowId))
    && includes(rule.stepPhases, stringPayload(payload.stepPhase ?? payload.phase))
    && includes(rule.toolNames, stringPayload(payload.toolName))
    && includes(rule.risks, stringPayload(payload.risk))
    && includes(rule.policyDecisions, stringPayload(payload.policyDecision ?? payload.decision));
}

function hookRuleResult(rule: NativeRuntimeHookRule): NativeRuntimeHookResult {
  return {
    decision: rule.decision,
    continue: rule.continue ?? continueForDecision(rule.decision),
    auditOnly: rule.auditOnly ?? rule.decision === "audit_only",
    reason: rule.reason,
    additionalContext: rule.additionalContext,
    ruleId: rule.id,
  };
}

function mergeHookResults(
  previous: NativeRuntimeHookResult,
  next: NativeRuntimeHookResult,
): NativeRuntimeHookResult {
  if (!next.continue) return next;
  if (!previous.continue) return previous;
  return decisionRank(next.decision) > decisionRank(previous.decision) ? next : previous;
}

async function recordHookResult(
  store: NativeAgentStore,
  input: NativeRuntimeHookInput,
  result: NativeRuntimeHookResult,
): Promise<void> {
  await recordHookDecisionEvent(store, input, result);
  if (!isRuntimeHookRecordEvent(input.hookEventName)) return;

  await store.recordRuntimeHook({
    agentRunId: input.agentRunId,
    hookEventName: input.hookEventName,
    decision: result.decision,
    payload: input.payload,
    result: hookResultJson(result),
  });
}

async function recordHookDecisionEvent(
  store: NativeAgentStore,
  input: NativeRuntimeHookInput,
  result: NativeRuntimeHookResult,
): Promise<void> {
  if (!input.agentRunId) return;
  await store.appendRunEvent({
    agentRunId: input.agentRunId,
    type: "run.hook.decision",
    payload: hookDecisionEventJson(input, result),
  });
}

function hookDecisionEventJson(input: NativeRuntimeHookInput, result: NativeRuntimeHookResult): JsonObject {
  return {
    hookEventName: input.hookEventName,
    decision: result.decision,
    continue: result.continue,
    auditOnly: result.auditOnly,
    hookPayload: input.payload ?? {},
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
    ...(result.ruleId ? { ruleId: result.ruleId } : {}),
  };
}

function hookResultJson(result: NativeRuntimeHookResult): JsonObject {
  return {
    decision: result.decision,
    continue: result.continue,
    auditOnly: result.auditOnly,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.additionalContext ? { additionalContext: result.additionalContext } : {}),
    ...(result.ruleId ? { ruleId: result.ruleId } : {}),
  };
}

function isRuntimeHookRecordEvent(eventName: NativeRuntimeHookName): eventName is NativeRuntimeHookEventName {
  return eventName === "PreToolUse"
    || eventName === "PostToolUse"
    || eventName === "PermissionRequest"
    || eventName === "PostCompact"
    || eventName === "Stop";
}

function defaultHookResult(): NativeRuntimeHookResult {
  return {
    decision: "audit_only",
    continue: true,
    auditOnly: true,
  };
}

function continueForDecision(decision: NativeRuntimeHookDecision): boolean {
  return decision !== "block" && decision !== "deny";
}

function decisionRank(decision: NativeRuntimeHookDecision): number {
  switch (decision) {
    case "audit_only":
      return 0;
    case "allow":
      return 1;
    case "ask":
      return 2;
    case "deny":
      return 3;
    case "block":
      return 4;
  }
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
  return !values || values.length === 0 || (value !== undefined && values.includes(value));
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
