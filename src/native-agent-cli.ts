import type { ServerConfig } from "./config.js";
import { assertPostgresSchemaReady } from "./db/postgres-migrations.js";
import { PostgresNativeAgentStore, type NativeAgentRunStatus, type NativeAgentToolRisk } from "./native-agent-store.js";
import { dispatchNativeAgentOnce, dispatchNativeAgentRunOnce } from "./native-agent-runtime.js";
import {
  createNativeAgentRetry,
  listNativeAgentApprovals,
  replayNativeAgentRun,
  requestNativeAgentApproval,
  resolveNativeAgentApproval,
} from "./native-agent-operator.js";
import { listNativeWorkflowPacks } from "./native-agent-workflows.js";

const ACTIONS = new Set([
  "dispatch-once",
  "dispatch-run",
  "resume",
  "list",
  "events",
  "replay",
  "cancel",
  "retry",
  "approvals",
  "request-approval",
  "approve",
  "deny",
  "workflows",
]);

type AgentAction =
  | "dispatch-once"
  | "dispatch-run"
  | "resume"
  | "list"
  | "events"
  | "replay"
  | "cancel"
  | "retry"
  | "approvals"
  | "request-approval"
  | "approve"
  | "deny"
  | "workflows";
type FlagValue = string | true;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue>;
}

export async function runNativeAgentCommand(args: string[], config: ServerConfig): Promise<void> {
  const [action, ...rest] = args;
  if (!isAgentAction(action)) {
    throw new Error("Usage: devspace agent <dispatch-once|dispatch-run|resume|list|events|replay|cancel|retry|approvals|request-approval|approve|deny|workflows> [...options]");
  }

  const parsed = parseArgs(rest);
  const json = parsed.flags.has("json");

  if (action === "workflows") {
    printOutput({ workflows: listNativeWorkflowPacks() }, json);
    return;
  }

  if (config.database.provider !== "postgres") {
    throw new Error("`devspace agent` commands require DEVSPACE_DATABASE_PROVIDER=postgres.");
  }
  await assertPostgresSchemaReady(config.database);

  switch (action) {
    case "dispatch-once": {
      const result = await dispatchNativeAgentOnce(config, {
        automationRunId: optionalString(parsed.flags, "automation-run-id"),
        workspaceRoot: optionalString(parsed.flags, "workspace-root"),
        workflowId: optionalString(parsed.flags, "workflow-id"),
        timeoutMs: optionalNumber(parsed.flags, "timeout-ms"),
        approvalTimeoutMs: optionalNumber(parsed.flags, "approval-timeout-ms"),
      });
      printOutput(result, json);
      return;
    }
    case "dispatch-run":
    case "resume": {
      const result = await dispatchNativeAgentRunOnce(config, {
        agentRunId: requiredString(parsed.flags, "id"),
        workspaceRoot: optionalString(parsed.flags, "workspace-root"),
        timeoutMs: optionalNumber(parsed.flags, "timeout-ms"),
        approvalTimeoutMs: optionalNumber(parsed.flags, "approval-timeout-ms"),
      });
      printOutput(result, json);
      return;
    }
    case "list": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const runs = await store.listAgentRuns({
          status: optionalStatus(parsed.flags),
          limit: optionalNumber(parsed.flags, "limit"),
        });
        printOutput({ runs }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "events": {
      const agentRunId = requiredString(parsed.flags, "id");
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const events = await store.readRunEvents({
          agentRunId,
          afterSeq: optionalNumber(parsed.flags, "after-seq"),
          maxEvents: optionalNumber(parsed.flags, "max-events"),
        });
        printOutput({ agentRunId, events }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "replay": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        printOutput(await replayNativeAgentRun(store, { agentRunId: requiredString(parsed.flags, "id") }), json);
      } finally {
        await store.close();
      }
      return;
    }
    case "cancel": {
      const agentRunId = requiredString(parsed.flags, "id");
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const run = await store.cancelAgentRun({
          agentRunId,
          reason: optionalString(parsed.flags, "reason"),
        });
        if (!run) throw new Error(`Native agent run not found: ${agentRunId}`);
        printOutput({ run }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "retry": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const retry = await createNativeAgentRetry(store, {
          agentRunId: requiredString(parsed.flags, "id"),
          reason: optionalString(parsed.flags, "reason"),
        });
        printOutput({ retry }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "approvals": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const approvals = await listNativeAgentApprovals(store, { agentRunId: requiredString(parsed.flags, "id") });
        printOutput({ approvals }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "request-approval": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const approval = await requestNativeAgentApproval(store, {
          agentRunId: requiredString(parsed.flags, "id"),
          title: optionalString(parsed.flags, "title") ?? "Approval requested",
          message: requiredString(parsed.flags, "message"),
          risk: optionalRisk(parsed.flags),
          requestedBy: optionalString(parsed.flags, "requested-by"),
          expiresAt: optionalString(parsed.flags, "expires-at"),
        });
        printOutput({ approval }, json);
      } finally {
        await store.close();
      }
      return;
    }
    case "approve":
    case "deny": {
      const store = new PostgresNativeAgentStore(config.database);
      try {
        const approval = await resolveNativeAgentApproval(store, {
          agentRunId: requiredString(parsed.flags, "id"),
          approvalId: requiredString(parsed.flags, "approval-id"),
          decision: action === "approve" ? "approved" : "denied",
          response: optionalString(parsed.flags, "message") ? { message: optionalString(parsed.flags, "message")! } : undefined,
          resolvedBy: optionalString(parsed.flags, "resolved-by"),
        });
        printOutput({ approval }, json);
      } finally {
        await store.close();
      }
      return;
    }
  }
}

function printOutput(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "object" && value !== null && "workflows" in value) {
    console.log("ID\tPermission\tSteps\tTitle");
    for (const workflow of (value as { workflows: ReturnType<typeof listNativeWorkflowPacks> }).workflows) {
      console.log([workflow.id, workflow.permissionProfile, workflow.steps.length, workflow.title].join("\t"));
    }
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, FlagValue>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (!name) throw new Error(`Invalid devspace agent option: ${arg}`);
    if (name === "json") {
      flags.set(name, true);
      continue;
    }
    const inlineValue = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : undefined;
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (inlineValue === undefined) index += 1;
    flags.set(name, value);
  }
  if (positionals.length > 0) throw new Error(`Unexpected devspace agent argument: ${positionals.join(" ")}`);
  return { positionals, flags };
}

function isAgentAction(value: string | undefined): value is AgentAction {
  return typeof value === "string" && ACTIONS.has(value);
}

function optionalString(flags: Map<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(flags: Map<string, FlagValue>, name: string): string {
  const value = optionalString(flags, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function optionalNumber(flags: Map<string, FlagValue>, name: string): number | undefined {
  const value = optionalString(flags, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
}

function optionalStatus(flags: Map<string, FlagValue>): NativeAgentRunStatus | undefined {
  const value = optionalString(flags, "status");
  if (!value) return undefined;
  if (
    value === "queued" ||
    value === "claiming" ||
    value === "running" ||
    value === "waiting_input" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed_out"
  ) return value;
  throw new Error(`Invalid --status: ${value}`);
}

function optionalRisk(flags: Map<string, FlagValue>): NativeAgentToolRisk | undefined {
  const value = optionalString(flags, "risk");
  if (!value) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Invalid --risk: ${value}`);
}
