import type { AutomationRun, JsonObject, JsonValue } from "./postgres-automation-store.js";
import type { NativeAgentPermissionProfile } from "./native-agent-store.js";

export type NativeWorkflowId = "manual" | "github-pr-review" | "feature-dev" | "security-review" | "test-fix";

export interface NativeWorkflowPack {
  id: NativeWorkflowId;
  title: string;
  permissionProfile: NativeAgentPermissionProfile;
  description: string;
  buildPrompt(input: NativeWorkflowInput): string;
}

export interface NativeWorkflowInput {
  automationRunId?: string;
  workflowId?: string;
  text?: string;
  payload?: JsonObject;
  metadata?: JsonObject;
  repository?: string;
  branch?: string;
  eventType?: string;
}

export interface NativeWorkflowExecution {
  workflow: NativeWorkflowPack;
  prompt: string;
  argv: string[];
  env: Record<string, string>;
  permissionProfile: NativeAgentPermissionProfile;
}

const WORKFLOWS: Record<NativeWorkflowId, NativeWorkflowPack> = {
  manual: {
    id: "manual",
    title: "Manual Native Agent Task",
    permissionProfile: "workspace_write",
    description: "Run a first-party Xautojs local task from a manual automation trigger.",
    buildPrompt: (input) => input.text ?? "Inspect the workspace and complete the requested local task.",
  },
  "github-pr-review": {
    id: "github-pr-review",
    title: "GitHub PR Review",
    permissionProfile: "workspace_write",
    description: "Review a GitHub pull_request event using local workspace context and produce auditable output.",
    buildPrompt: (input) => [
      "Review the GitHub pull request event for correctness, tests, security, and maintainability.",
      input.repository ? `Repository: ${input.repository}` : undefined,
      input.branch ? `Branch: ${input.branch}` : undefined,
      input.eventType ? `Event: ${input.eventType}` : undefined,
      "Use local workspace tools only through Xautojs policy.",
    ].filter(Boolean).join("\n"),
  },
  "feature-dev": {
    id: "feature-dev",
    title: "Feature Development",
    permissionProfile: "workspace_write",
    description: "Plan, implement, and verify a bounded feature request in the local workspace.",
    buildPrompt: (input) => input.text ?? "Implement the requested feature with focused tests and a concise change summary.",
  },
  "security-review": {
    id: "security-review",
    title: "Security Review",
    permissionProfile: "read_only",
    description: "Inspect code for command injection, XSS, SSRF, secrets, unsafe eval, and auth boundary regressions.",
    buildPrompt: (input) => input.text ?? "Perform a read-only security review and report actionable findings.",
  },
  "test-fix": {
    id: "test-fix",
    title: "Test Failure Fix",
    permissionProfile: "workspace_write",
    description: "Investigate failing tests and apply the smallest safe fix.",
    buildPrompt: (input) => input.text ?? "Investigate the failing test signal, patch the root cause, and re-run the narrow check.",
  },
};

export function listNativeWorkflowPacks(): NativeWorkflowPack[] {
  return Object.values(WORKFLOWS);
}

export function getNativeWorkflowPack(id: string | undefined): NativeWorkflowPack {
  if (id && isNativeWorkflowId(id)) return WORKFLOWS[id];
  return WORKFLOWS.manual;
}

export function workflowIdFromAutomationMetadata(metadata: JsonObject): NativeWorkflowId {
  const explicit = stringJson(metadata.workflowId);
  if (explicit && isNativeWorkflowId(explicit)) return explicit;
  if (metadata.provider === "github") return "github-pr-review";
  return "manual";
}

export function workflowInputFromAutomationRun(run: AutomationRun): NativeWorkflowInput {
  return {
    automationRunId: run.id,
    workflowId: stringJson(run.metadata.workflowId),
    text: stringJson(run.result.text) ?? stringJson(run.metadata.text),
    payload: objectJson(run.result.payload) ?? objectJson(run.metadata.payload),
    metadata: run.metadata,
    repository: stringJson(run.metadata.repository),
    branch: stringJson(run.metadata.branch),
    eventType: stringJson(run.metadata.eventType),
  };
}

export function workflowInputFromAgentInput(input: JsonObject): NativeWorkflowInput {
  const metadata = objectJson(input.metadata) ?? {};
  return {
    automationRunId: stringJson(input.automationRunId),
    workflowId: stringJson(input.workflowId) ?? stringJson(metadata.workflowId),
    text: stringJson(input.text),
    payload: objectJson(input.payload),
    metadata,
    repository: stringJson(metadata.repository),
    branch: stringJson(metadata.branch),
    eventType: stringJson(metadata.eventType),
  };
}

export function buildNativeWorkflowExecution(input: NativeWorkflowInput): NativeWorkflowExecution {
  const workflow = getNativeWorkflowPack(input.workflowId ?? workflowIdFromAutomationMetadata(input.metadata ?? {}));
  const prompt = workflow.buildPrompt(input);
  const executionInput = {
    workflowId: workflow.id,
    title: workflow.title,
    prompt,
    automationRunId: input.automationRunId ?? null,
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    eventType: input.eventType ?? null,
  };
  return {
    workflow,
    prompt,
    argv: [
      process.execPath,
      "-e",
      [
        "const input = JSON.parse(process.env.DEVSPACE_NATIVE_AGENT_INPUT || '{}');",
        "console.log(JSON.stringify({",
        "  status: 'ready',",
        "  workflowId: input.workflowId,",
        "  title: input.title,",
        "  automationRunId: input.automationRunId,",
        "  repository: input.repository,",
        "  branch: input.branch,",
        "  eventType: input.eventType,",
        "  prompt: input.prompt",
        "}, null, 2));",
      ].join("\n"),
    ],
    env: {
      DEVSPACE_NATIVE_AGENT_INPUT: JSON.stringify(executionInput),
    },
    permissionProfile: workflow.permissionProfile,
  };
}

function isNativeWorkflowId(value: string): value is NativeWorkflowId {
  return value === "manual" || value === "github-pr-review" || value === "feature-dev" || value === "security-review" || value === "test-fix";
}

function stringJson(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectJson(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
