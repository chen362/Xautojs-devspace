#!/usr/bin/env node
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";
import {
  startDesktopCloudAgentFromPayload,
  type DesktopCloudAgentApprovalMode,
  type DesktopCloudAgentPayload,
} from "./desktop-cloud-agent-runner.js";

interface RunnerArgs {
  stdin: boolean;
  once: boolean;
  approvalMode?: DesktopCloudAgentApprovalMode;
}

export async function runDesktopCloudAgentCli(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const parsed = parseArgs(args);
  const payload = await readPayload(parsed);
  const started = startDesktopCloudAgentFromPayload(payload, {
    approvalMode: parsed.approvalMode ?? approvalModeFromEnv(),
  });
  console.log(JSON.stringify({ ok: true, snapshot: started.snapshot }));

  if (parsed.once) {
    started.lifecycle.stop("desktop_agent_once");
    return;
  }

  await waitForShutdown(() => {
    started.lifecycle.stop("desktop_agent_shutdown");
  });
}

function parseArgs(args: string[]): RunnerArgs {
  const parsed: RunnerArgs = { stdin: false, once: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--stdin") {
      parsed.stdin = true;
      continue;
    }
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }
    if (arg === "--approval-mode") {
      parsed.approvalMode = parseApprovalMode(readOptionValue(args, ++index, arg));
      continue;
    }
    throw new Error(`Unexpected desktop cloud agent option: ${arg}`);
  }

  if (!parsed.stdin) throw new Error("Desktop cloud agent runner requires --stdin.");
  return parsed;
}

async function readPayload(args: RunnerArgs): Promise<DesktopCloudAgentPayload> {
  if (!args.stdin) throw new Error("Only --stdin payload input is supported.");
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("Desktop cloud agent runner received an empty payload.");
  return JSON.parse(raw) as DesktopCloudAgentPayload;
}

function waitForShutdown(stop: () => void): Promise<void> {
  return new Promise((resolve) => {
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function approvalModeFromEnv(): DesktopCloudAgentApprovalMode {
  return parseApprovalMode(process.env.DEVSPACE_DESKTOP_APPROVAL_MODE || "desktop_prompt");
}

function parseApprovalMode(value: string): DesktopCloudAgentApprovalMode {
  if (value === "deny" || value === "auto_approve" || value === "desktop_prompt") return value;
  throw new Error("approval mode must be one of: deny, auto_approve, desktop_prompt");
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
  return value;
}

function printHelp(): void {
  console.log([
    "DevSpace Desktop cloud agent",
    "",
    "Usage:",
    "  devspace-desktop-agent --stdin [--approval-mode deny|auto_approve|desktop_prompt]",
    "",
    "The payload is read from stdin so the device token is not exposed in process arguments.",
    "By default destructive tool calls use the Desktop native approval prompt.",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDesktopCloudAgentCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
