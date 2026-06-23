import type {
  NativeAgentToolRisk,
  NativeRuntimeHookDecision,
  NativeRuntimeHookEventName,
} from "./native-agent-store.js";
import type { NativeWorkflowStepPhase } from "./native-agent-workflows.js";

export type NativeRuntimeHookStage = "before" | "after";

export interface NativeRuntimeHookRule {
  id: string;
  events: NativeRuntimeHookEventName[];
  stages?: NativeRuntimeHookStage[];
  workflowIds?: string[];
  stepPhases?: NativeWorkflowStepPhase[];
  toolNames?: string[];
  risks?: NativeAgentToolRisk[];
  policyDecisions?: NativeRuntimeHookDecision[];
  decision: NativeRuntimeHookDecision;
  continue?: boolean;
  auditOnly?: boolean;
  reason?: string;
  additionalContext?: string;
}

export interface NativeRuntimeHookConfig {
  enabled: boolean;
  rules: NativeRuntimeHookRule[];
}

const runtimeHookEvents: NativeRuntimeHookEventName[] = [
  "Start",
  "WorkflowStep",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PostCompact",
  "Stop",
];
const runtimeHookStages: NativeRuntimeHookStage[] = ["before", "after"];
const runtimeHookDecisions: NativeRuntimeHookDecision[] = ["allow", "block", "ask", "deny", "audit_only"];
const nativeToolRisks: NativeAgentToolRisk[] = ["low", "medium", "high"];
const workflowStepPhases: NativeWorkflowStepPhase[] = ["plan", "execute", "verify", "handoff"];

export function loadNativeRuntimeHookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NativeRuntimeHookConfig {
  const raw = env.DEVSPACE_NATIVE_RUNTIME_HOOKS?.trim();
  if (!raw) return defaultNativeRuntimeHookConfig();

  try {
    return parseNativeRuntimeHookConfig(JSON.parse(raw), "DEVSPACE_NATIVE_RUNTIME_HOOKS");
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid DEVSPACE_NATIVE_RUNTIME_HOOKS: ${error.message}`);
    }
    throw error;
  }
}

export function parseNativeRuntimeHookConfig(
  value: unknown,
  source = "nativeRuntimeHooks",
): NativeRuntimeHookConfig {
  if (value === undefined || value === null || value === "") return defaultNativeRuntimeHookConfig();
  const record = objectRecord(value, source);
  return {
    enabled: optionalBoolean(record.enabled, true, `${source}.enabled`),
    rules: optionalArray(record.rules, `${source}.rules`).map((entry, index) => parseRule(entry, `${source}.rules[${index}]`)),
  };
}

export function defaultNativeRuntimeHookConfig(): NativeRuntimeHookConfig {
  return { enabled: true, rules: [] };
}

function parseRule(value: unknown, source: string): NativeRuntimeHookRule {
  const record = objectRecord(value, source);
  const id = requiredString(record.id, `${source}.id`);
  const events = parseEnumList(
    record.events ?? record.event,
    runtimeHookEvents,
    `${source}.events`,
    true,
  ) as NativeRuntimeHookEventName[];
  const decision = parseEnum(record.decision, runtimeHookDecisions, `${source}.decision`) as NativeRuntimeHookDecision;

  return {
    id,
    events,
    stages: parseOptionalEnumList(record.stages ?? record.stage, runtimeHookStages, `${source}.stages`) as NativeRuntimeHookStage[] | undefined,
    workflowIds: parseOptionalStringList(record.workflowIds ?? record.workflowId, `${source}.workflowIds`),
    stepPhases: parseOptionalEnumList(record.stepPhases ?? record.stepPhase, workflowStepPhases, `${source}.stepPhases`) as NativeWorkflowStepPhase[] | undefined,
    toolNames: parseOptionalStringList(record.toolNames ?? record.toolName, `${source}.toolNames`),
    risks: parseOptionalEnumList(record.risks ?? record.risk, nativeToolRisks, `${source}.risks`) as NativeAgentToolRisk[] | undefined,
    policyDecisions: parseOptionalEnumList(
      record.policyDecisions ?? record.policyDecision,
      runtimeHookDecisions,
      `${source}.policyDecisions`,
    ) as NativeRuntimeHookDecision[] | undefined,
    decision,
    continue: optionalBoolean(record.continue, undefined, `${source}.continue`),
    auditOnly: optionalBoolean(record.auditOnly, undefined, `${source}.auditOnly`),
    reason: optionalString(record.reason, `${source}.reason`),
    additionalContext: optionalString(record.additionalContext, `${source}.additionalContext`),
  };
}

function objectRecord(value: unknown, source: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(`${source} must be an object.`);
}

function optionalArray(value: unknown, source: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new Error(`${source} must be an array.`);
}

function requiredString(value: unknown, source: string): string {
  const parsed = optionalString(value, source);
  if (parsed) return parsed;
  throw new Error(`${source} is required.`);
}

function optionalString(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${source} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean<T extends boolean | undefined>(value: unknown, fallback: T, source: string): boolean | T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${source} must be a boolean.`);
}

function parseEnum(value: unknown, allowed: readonly string[], source: string): string {
  const parsed = requiredString(value, source);
  if (allowed.includes(parsed)) return parsed;
  throw new Error(`${source} must be one of: ${allowed.join(", ")}.`);
}

function parseOptionalEnumList(value: unknown, allowed: readonly string[], source: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return parseEnumList(value, allowed, source, false);
}

function parseEnumList(value: unknown, allowed: readonly string[], source: string, required: boolean): string[] {
  const entries = parseStringArray(value, source, required);
  for (const entry of entries) {
    if (!allowed.includes(entry)) throw new Error(`${source} contains invalid value: ${entry}.`);
  }
  return entries;
}

function parseOptionalStringList(value: unknown, source: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return parseStringArray(value, source, false);
}

function parseStringArray(value: unknown, source: string, required: boolean): string[] {
  const rawEntries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  if (rawEntries.length === 0) {
    if (required) throw new Error(`${source} is required.`);
    return [];
  }

  const entries = rawEntries.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${source}[${index}] must be a string.`);
    return entry.trim();
  }).filter(Boolean);
  if (required && entries.length === 0) throw new Error(`${source} is required.`);
  return Array.from(new Set(entries));
}
