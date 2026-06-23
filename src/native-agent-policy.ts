import { basename, resolve } from "node:path";
import { isPathInsideRoot } from "./roots.js";
import type { NativeAgentPermissionProfile, NativeAgentToolRisk } from "./native-agent-store.js";

export type NativePolicyDecision = "allow" | "block" | "ask" | "audit_only";

export interface NativePolicyResult {
  decision: NativePolicyDecision;
  risk: NativeAgentToolRisk;
  reason: string;
  approvalTitle?: string;
  approvalMessage?: string;
}

export interface NativeCommandPolicyInput {
  permissionProfile: NativeAgentPermissionProfile;
  argv: string[];
  cwd: string;
  workspaceRoot?: string;
  internal?: boolean;
  network?: boolean;
}

const HIGH_RISK_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "format",
  "mkfs",
  "sudo",
  "su",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "powershell",
  "powershell.exe",
  "pwsh",
  "cmd",
  "cmd.exe",
  "bash",
  "sh",
  "zsh",
]);

const MEDIUM_RISK_COMMANDS = new Set([
  "git",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "node",
  "python",
  "python3",
]);

export function evaluateNativeCommandPolicy(input: NativeCommandPolicyInput): NativePolicyResult {
  if (input.argv.length === 0 || !input.argv[0]?.trim()) {
    return block("Command argv must not be empty.", "high");
  }

  if (input.workspaceRoot && !isPathInsideRoot(resolve(input.cwd), resolve(input.workspaceRoot))) {
    return block("Command working directory is outside the workspace root.", "high");
  }

  if (input.permissionProfile === "read_only") {
    return block("read_only native agent profile does not allow process execution.", "medium");
  }

  const command = commandName(input.argv[0]);
  const risk = commandRisk(command, input);

  if (input.permissionProfile === "trusted_local") {
    return {
      decision: risk === "high" ? "audit_only" : "allow",
      risk,
      reason: risk === "high" ? "trusted_local permits the command but records a high-risk audit decision." : "trusted_local permits the command.",
    };
  }

  if (input.internal && isNodeLikeCommand(command)) {
    return allow("Internal Xautojs workflow command is allowed for workspace_write.", risk);
  }

  if (risk === "high") {
    return ask(`workspace_write requires approval for high-risk command: ${command}`, risk, {
      approvalTitle: "Approve high-risk native command",
      approvalMessage: `Allow Xautojs to run high-risk command '${command}' inside the workspace?`,
    });
  }

  if (input.network) {
    return ask("workspace_write requires approval for network-enabled commands.", "high", {
      approvalTitle: "Approve network-enabled native command",
      approvalMessage: "Allow Xautojs to run a network-enabled command inside the workspace?",
    });
  }

  return allow("workspace_write permits low and medium risk local commands inside the workspace.", risk);
}

export function classifyNativeToolRisk(toolName: string, input: Record<string, unknown> = {}): NativeAgentToolRisk {
  if (toolName === "read" || toolName === "grep" || toolName === "glob" || toolName === "ls") return "low";
  if (toolName === "write" || toolName === "edit") return "medium";
  if (toolName === "shell" || toolName === "process") return "high";
  if (typeof input.command === "string" && looksDangerous(input.command)) return "high";
  return "medium";
}

function commandRisk(command: string, input: NativeCommandPolicyInput): NativeAgentToolRisk {
  if (input.network || HIGH_RISK_COMMANDS.has(command)) return "high";
  if (MEDIUM_RISK_COMMANDS.has(command) || input.internal) return "medium";
  return "low";
}

function commandName(commandPath: string): string {
  return basename(commandPath).toLowerCase();
}

function isNodeLikeCommand(command: string): boolean {
  return command === "node" || command === "node.exe" || command === basename(process.execPath).toLowerCase();
}

function looksDangerous(command: string): boolean {
  const lowered = command.toLowerCase();
  return ["rm -rf", "sudo ", "curl ", "wget ", "powershell", "cmd.exe", "chmod 777"].some((pattern) => lowered.includes(pattern));
}

function allow(reason: string, risk: NativeAgentToolRisk): NativePolicyResult {
  return { decision: "allow", risk, reason };
}

function ask(reason: string, risk: NativeAgentToolRisk, approval: Pick<NativePolicyResult, "approvalTitle" | "approvalMessage">): NativePolicyResult {
  return { decision: "ask", risk, reason, ...approval };
}

function block(reason: string, risk: NativeAgentToolRisk): NativePolicyResult {
  return { decision: "block", risk, reason };
}
