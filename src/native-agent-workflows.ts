import type { AutomationRun, JsonObject, JsonValue } from "./postgres-automation-store.js";
import type { NativeAgentPermissionProfile } from "./native-agent-store.js";

export type NativeWorkflowId = "manual" | "github-pr-review" | "feature-dev" | "security-review" | "test-fix";
export type NativeWorkflowStepPhase = "plan" | "execute" | "verify" | "handoff";
export type NativeWorkflowStepAction = "observe" | "decide" | "modify" | "test" | "report";

export interface NativeWorkflowStep {
  id: string;
  title: string;
  phase: NativeWorkflowStepPhase;
  action: NativeWorkflowStepAction;
  objective: string;
  expectedOutput: string;
  acceptanceCriteria: string[];
  suggestedTools?: string[];
}

export interface NativeWorkflowExecutionPlan {
  version: "native-workflow-pack/v1";
  workflowId: NativeWorkflowId;
  title: string;
  permissionProfile: NativeAgentPermissionProfile;
  phases: NativeWorkflowStepPhase[];
  steps: NativeWorkflowStep[];
  successCriteria: string[];
  failureModes: string[];
}

export interface NativeWorkflowPack {
  id: NativeWorkflowId;
  title: string;
  permissionProfile: NativeAgentPermissionProfile;
  description: string;
  steps: NativeWorkflowStep[];
  successCriteria: string[];
  failureModes: string[];
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
  steps: NativeWorkflowStep[];
  executionPlan: NativeWorkflowExecutionPlan;
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
    steps: [
      step("understand", "Understand request", "plan", "observe", "Normalize the request and workspace context.", "A bounded task summary with known workspace constraints.", [
        "The operator request is restated as an actionable local task.",
        "Workspace root, workflow id, and permission profile are visible in the plan.",
      ], ["read", "grep", "glob"]),
      step("act", "Act locally", "execute", "modify", "Execute the smallest safe local action allowed by policy.", "A focused local change or an explicit no-op with reason.", [
        "Any mutation is scoped to the requested task.",
        "Policy approval is requested before high-risk execution.",
      ], ["read", "edit", "process"]),
      step("verify", "Verify result", "verify", "test", "Run the narrowest useful check for the completed action.", "A verification signal or a clearly documented reason verification was skipped.", [
        "The check directly covers the local action.",
        "Failures are captured as evidence instead of hidden.",
      ], ["process"]),
      step("summarize", "Summarize result", "handoff", "report", "Record a concise operator-facing result.", "A short handoff with changed behavior, verification, and follow-up risk.", [
        "The summary names the outcome and any remaining risk.",
        "The operator can decide the next action without reading raw logs.",
      ]),
    ],
    successCriteria: [
      "The requested local task is either completed or explicitly declined with a safe reason.",
      "Every material action is represented in the event stream.",
      "The final handoff includes verification status.",
    ],
    failureModes: [
      "Workspace root is unavailable or outside allowed roots.",
      "Policy blocks or times out before execution.",
      "Verification fails and needs a retry run.",
    ],
    buildPrompt: (input) => input.text ?? "Inspect the workspace and complete the requested local task.",
  },
  "github-pr-review": {
    id: "github-pr-review",
    title: "GitHub PR Review",
    permissionProfile: "workspace_write",
    description: "Review a GitHub pull_request event using local workspace context and produce auditable output.",
    steps: [
      step("normalize-event", "Normalize GitHub event", "plan", "observe", "Identify repository, branch, event type, and requested review target.", "A normalized review target with repository, branch, and event semantics.", [
        "Repository and branch are included when available.",
        "Unsupported or incomplete webhook metadata falls back to a safe manual review shape.",
      ], ["read"]),
      step("inspect-change", "Inspect local change", "execute", "observe", "Use local workspace context to inspect changed code and tests.", "A structured list of files, test surfaces, and relevant local context.", [
        "Inspection stays inside the resolved workspace root.",
        "The review target is grounded in local files or recorded as missing context.",
      ], ["grep", "glob", "read"]),
      step("risk-review", "Review risk", "verify", "decide", "Check correctness, security, compatibility, and missing tests.", "Prioritized findings or an explicit no-findings result.", [
        "Correctness, security, compatibility, and test gaps are considered.",
        "Findings include enough evidence for an operator to act.",
      ]),
      step("report", "Report findings", "handoff", "report", "Produce an auditable review summary with next actions.", "A concise review report suitable for operator replay or PR comment drafting.", [
        "The report separates blocking findings from residual risk.",
        "The report does not claim tests passed unless evidence exists.",
      ]),
    ],
    successCriteria: [
      "The webhook is normalized into a stable PR review target.",
      "The output is grounded in local workspace evidence.",
      "The final report is actionable and replayable.",
    ],
    failureModes: [
      "Repository metadata is missing and no local context can be resolved.",
      "Workspace inspection is blocked by policy or path restrictions.",
      "The local workspace does not contain the target change.",
    ],
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
    steps: [
      step("plan", "Plan change", "plan", "decide", "Map the request to a small implementation path.", "A compact implementation plan with target files and verification path.", [
        "The plan names the intended code surface.",
        "The plan avoids unrelated refactors.",
      ], ["read", "grep", "glob"]),
      step("patch", "Patch workspace", "execute", "modify", "Apply the focused code or configuration change.", "A scoped code/configuration patch.", [
        "The patch preserves existing public contracts unless intentionally extended.",
        "The patch is limited to the workflow objective.",
      ], ["edit"]),
      step("verify", "Verify", "verify", "test", "Run the narrowest useful checks.", "A passing check or a captured failure reason.", [
        "At least one relevant check is selected when feasible.",
        "Failure output is preserved for retry/replay.",
      ], ["process"]),
      step("handoff", "Handoff", "handoff", "report", "Summarize changed behavior and verification.", "An operator-ready change summary.", [
        "The handoff names changed behavior.",
        "The handoff names verification commands and results.",
      ]),
    ],
    successCriteria: [
      "The feature request maps to a bounded patch.",
      "The patch is verified or the verification gap is explicit.",
      "The final result can be reviewed from events without rerunning the task.",
    ],
    failureModes: [
      "The request is too broad for a bounded local patch.",
      "Required files are missing from the workspace.",
      "Verification fails and needs retry/replay.",
    ],
    buildPrompt: (input) => input.text ?? "Implement the requested feature with focused tests and a concise change summary.",
  },
  "security-review": {
    id: "security-review",
    title: "Security Review",
    permissionProfile: "read_only",
    description: "Inspect code for command injection, XSS, SSRF, secrets, unsafe eval, and auth boundary regressions.",
    steps: [
      step("scope", "Scope review", "plan", "observe", "Identify security-sensitive surfaces and trust boundaries.", "A scoped list of security-relevant files and trust boundaries.", [
        "Authentication, authorization, command execution, path access, and network boundaries are considered.",
        "Review scope is read-only and path-bounded.",
      ], ["grep", "glob", "read"]),
      step("inspect", "Inspect safely", "execute", "observe", "Review code paths without mutating the workspace.", "Evidence-backed observations for sensitive code paths.", [
        "No workspace mutation is required.",
        "Each observation references a concrete behavior or file surface.",
      ], ["read", "grep"]),
      step("findings", "Report findings", "verify", "report", "Return actionable issues with evidence and severity.", "A prioritized security review result.", [
        "Findings are ranked by severity.",
        "No finding is reported without enough evidence.",
      ]),
    ],
    successCriteria: [
      "The review stays read-only.",
      "Findings are actionable, evidenced, and severity-ranked.",
      "No-finding outcomes still describe reviewed surfaces.",
    ],
    failureModes: [
      "The workspace cannot be inspected read-only.",
      "Security-sensitive surfaces cannot be identified from available files.",
      "The request requires mutation, which is outside this workflow profile.",
    ],
    buildPrompt: (input) => input.text ?? "Perform a read-only security review and report actionable findings.",
  },
  "test-fix": {
    id: "test-fix",
    title: "Test Failure Fix",
    permissionProfile: "workspace_write",
    description: "Investigate failing tests and apply the smallest safe fix.",
    steps: [
      step("reproduce", "Reproduce failure", "plan", "test", "Capture the failing signal and likely root cause.", "A failing test signal or a clear explanation of why reproduction is unavailable.", [
        "The command or signal being investigated is recorded.",
        "The suspected failure surface is named.",
      ], ["process", "read"]),
      step("patch", "Patch root cause", "execute", "modify", "Apply the smallest safe correction.", "A focused patch for the likely root cause.", [
        "The patch targets the failure cause rather than masking symptoms.",
        "Unrelated behavior is preserved.",
      ], ["edit"]),
      step("rerun", "Rerun check", "verify", "test", "Verify the fixed path with focused tests.", "A rerun result for the failing path.", [
        "The original failing signal is rerun when feasible.",
        "Any remaining failure is captured for retry.",
      ], ["process"]),
      step("handoff", "Handoff", "handoff", "report", "Summarize root cause, patch, and verification.", "A concise debugging handoff.", [
        "The root cause is stated as evidence-backed or still uncertain.",
        "Verification status is explicit.",
      ]),
    ],
    successCriteria: [
      "The failing signal is reproduced or explicitly unavailable.",
      "The smallest safe fix is applied.",
      "The original failure path is verified or the remaining blocker is clear.",
    ],
    failureModes: [
      "The failure signal is missing or non-deterministic.",
      "The likely root cause requires a broader product decision.",
      "The verification command is blocked by policy.",
    ],
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
  const executionPlan = buildExecutionPlan(workflow);
  const executionInput = {
    workflowId: workflow.id,
    title: workflow.title,
    prompt,
    steps: workflow.steps,
    executionPlan,
    automationRunId: input.automationRunId ?? null,
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    eventType: input.eventType ?? null,
  };
  return {
    workflow,
    prompt,
    steps: workflow.steps,
    executionPlan,
    argv: [
      process.execPath,
      "-e",
      [
        "const input = JSON.parse(process.env.DEVSPACE_NATIVE_AGENT_INPUT || '{}');",
        "console.log(JSON.stringify({",
        "  status: 'ready',",
        "  workflowId: input.workflowId,",
        "  title: input.title,",
        "  steps: input.steps,",
        "  executionPlan: input.executionPlan,",
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

function buildExecutionPlan(workflow: NativeWorkflowPack): NativeWorkflowExecutionPlan {
  return {
    version: "native-workflow-pack/v1",
    workflowId: workflow.id,
    title: workflow.title,
    permissionProfile: workflow.permissionProfile,
    phases: orderedPhases(workflow.steps),
    steps: workflow.steps,
    successCriteria: workflow.successCriteria,
    failureModes: workflow.failureModes,
  };
}

function orderedPhases(steps: NativeWorkflowStep[]): NativeWorkflowStepPhase[] {
  const seen = new Set<NativeWorkflowStepPhase>();
  const phases: NativeWorkflowStepPhase[] = [];
  for (const step of steps) {
    if (seen.has(step.phase)) continue;
    seen.add(step.phase);
    phases.push(step.phase);
  }
  return phases;
}

function step(
  id: string,
  title: string,
  phase: NativeWorkflowStepPhase,
  action: NativeWorkflowStepAction,
  objective: string,
  expectedOutput: string,
  acceptanceCriteria: string[],
  suggestedTools?: string[],
): NativeWorkflowStep {
  return {
    id,
    title,
    phase,
    action,
    objective,
    expectedOutput,
    acceptanceCriteria,
    ...(suggestedTools ? { suggestedTools } : {}),
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
