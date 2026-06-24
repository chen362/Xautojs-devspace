import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { DesktopOutboundAgentLifecycle, type DesktopOutboundAgentSnapshot } from "./desktop-outbound-agent-lifecycle.js";
import type {
  LocalAgentSocketFactory,
  LocalAgentWorkspaceCatalogSnapshot,
} from "./local-agent-outbound-client.js";
import {
  LocalAgentToolReceiver,
  type LocalAgentApprovalDecision,
  type LocalAgentApprovalPrompt,
  type LocalAgentApprovalRequest,
} from "./local-agent-receiver.js";
import { LOCAL_WORKSPACE_IDENTITY } from "./identity.js";
import type {
  DevspaceToolExecutionContext,
  DevspaceToolExecutor,
  EditFileToolDetails,
  EditFileToolInput,
  FindFilesToolInput,
  GrepFilesToolInput,
  ListDirectoryToolInput,
  ReadFileToolInput,
  RunShellToolInput,
  ShowChangesToolInput,
  ToolResponse,
  WriteFileToolInput,
} from "./mcp-tool-executor.js";
import { LocalMcpToolExecutor } from "./local-mcp-tool-executor.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";
import { expandHomePath } from "./roots.js";
import type { WorkspaceContext } from "./workspaces.js";
import { WorkspaceRegistry } from "./workspaces.js";

export type DesktopCloudAgentApprovalMode = "deny" | "auto_approve" | "desktop_prompt";

export interface DesktopCloudAgentWorkspacePayload {
  workspaceRef: string;
  displayName: string;
  rootLabel: string;
  localRoot?: string;
  capabilities: string[];
}

export interface DesktopCloudAgentPayload {
  url: string;
  authToken: string;
  deviceId: string;
  desktopInstanceId?: string;
  workspaceCatalog: {
    catalogVersion?: string;
    workspaces: DesktopCloudAgentWorkspacePayload[];
  };
}

export interface DesktopCloudAgentRunnerOptions {
  socketFactory?: LocalAgentSocketFactory;
  approvalPrompt?: LocalAgentApprovalPrompt;
  approvalMode?: DesktopCloudAgentApprovalMode;
  now?: () => string;
}

export interface StartedDesktopCloudAgent {
  lifecycle: DesktopOutboundAgentLifecycle;
  snapshot: DesktopOutboundAgentSnapshot;
}

export interface NormalizedDesktopCloudAgentWorkspace {
  workspaceRef: string;
  displayName: string;
  rootLabel: string;
  localRoot: string;
  capabilities: string[];
}

export function startDesktopCloudAgentFromPayload(
  payload: DesktopCloudAgentPayload,
  options: DesktopCloudAgentRunnerOptions = {},
): StartedDesktopCloudAgent {
  const normalized = normalizePayload(payload);
  const executor = createDesktopCloudAgentExecutor(normalized);
  const receiver = new LocalAgentToolReceiver(executor, {
    approvalPrompt: options.approvalPrompt ?? approvalPromptFor(options.approvalMode),
  });
  const lifecycle = new DesktopOutboundAgentLifecycle();
  const snapshot = lifecycle.start({
    url: normalized.url,
    authToken: normalized.authToken,
    deviceId: normalized.deviceId,
    desktopInstanceId: normalized.desktopInstanceId,
    agentVersion: "xautojs-devspace-desktop-agent",
    capabilities: capabilitiesFor(normalized.workspaces),
    receiver,
    workspaceCatalogProvider: () => workspaceCatalogSnapshot(normalized),
    socketFactory: options.socketFactory,
    now: options.now,
  });
  return { lifecycle, snapshot };
}

export class DesktopCloudWorkspaceExecutor implements DevspaceToolExecutor {
  private readonly cloudToLocalWorkspaceIds = new Map<string, string>();

  constructor(
    private readonly delegate: DevspaceToolExecutor,
    private readonly input: {
      deviceId: string;
      workspaces: NormalizedDesktopCloudAgentWorkspace[];
    },
  ) {}

  openWorkspace(
    context: DevspaceToolExecutionContext,
    input: { path: string; mode?: "checkout" | "worktree"; baseRef?: string },
  ): Promise<WorkspaceContext> {
    return this.delegate.openWorkspace(context, input);
  }

  async readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.readFile(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.writeFile(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    return this.delegate.editFile(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.grepFiles(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.findFiles(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.listDirectory(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    return this.delegate.runShell(context, await this.localWorkspaceId(context, workspaceId), input);
  }

  async showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult> {
    return this.delegate.showChanges(context, {
      ...input,
      workspaceId: await this.localWorkspaceId(context, input.workspaceId),
    });
  }

  private async localWorkspaceId(context: DevspaceToolExecutionContext, cloudWorkspaceId: string): Promise<string> {
    const key = workspaceMapKey(context, cloudWorkspaceId);
    const existing = this.cloudToLocalWorkspaceIds.get(key);
    if (existing) return existing;

    const workspace = this.findWorkspace(context, cloudWorkspaceId);
    if (!workspace) {
      throw new Error(`Unknown cloud workspaceId: ${cloudWorkspaceId}. Select a workspace from the Desktop catalog first.`);
    }

    const opened = await this.delegate.openWorkspace(context, { path: workspace.localRoot });
    this.cloudToLocalWorkspaceIds.set(key, opened.workspace.id);
    return opened.workspace.id;
  }

  private findWorkspace(
    context: DevspaceToolExecutionContext,
    cloudWorkspaceId: string,
  ): NormalizedDesktopCloudAgentWorkspace | undefined {
    return this.input.workspaces.find((workspace) => {
      if (workspace.workspaceRef === cloudWorkspaceId) return true;
      return deterministicCloudWorkspaceId({
        tenantId: context.owner.tenantId,
        userId: context.owner.userId,
        mcpSessionId: context.mcpSessionId,
        conversationSessionId: context.conversationSessionId,
        deviceId: context.deviceId ?? this.input.deviceId,
        workspaceRef: workspace.workspaceRef,
      }) === cloudWorkspaceId;
    });
  }
}

export function deterministicCloudWorkspaceId(input: {
  tenantId: string;
  userId: string;
  mcpSessionId: string;
  conversationSessionId?: string;
  deviceId: string;
  workspaceRef: string;
}): string {
  const digest = createHash("sha256").update(stableFingerprint(input)).digest("base64url").slice(0, 24);
  return `cw_${digest}`;
}

function createDesktopCloudAgentExecutor(input: ReturnType<typeof normalizePayload>): DevspaceToolExecutor {
  const config = localAgentServerConfig(input.workspaces.map((workspace) => workspace.localRoot));
  const workspaces = new WorkspaceRegistry(config, undefined, LOCAL_WORKSPACE_IDENTITY, () => ({}));
  const delegate = new LocalMcpToolExecutor(config, workspaces, createReviewCheckpointManager());
  return new DesktopCloudWorkspaceExecutor(delegate, {
    deviceId: input.deviceId,
    workspaces: input.workspaces,
  });
}

function normalizePayload(payload: DesktopCloudAgentPayload): {
  url: string;
  authToken: string;
  deviceId: string;
  desktopInstanceId?: string;
  catalogVersion?: string;
  workspaces: NormalizedDesktopCloudAgentWorkspace[];
} {
  return {
    url: required(payload.url, "url"),
    authToken: required(payload.authToken, "authToken"),
    deviceId: required(payload.deviceId, "deviceId"),
    desktopInstanceId: optional(payload.desktopInstanceId),
    catalogVersion: optional(payload.workspaceCatalog?.catalogVersion),
    workspaces: (payload.workspaceCatalog?.workspaces ?? []).map(normalizeWorkspacePayload),
  };
}

function normalizeWorkspacePayload(
  workspace: DesktopCloudAgentWorkspacePayload,
): NormalizedDesktopCloudAgentWorkspace {
  const workspaceRef = required(workspace.workspaceRef, "workspaceRef");
  const localRoot = resolve(expandHomePath(required(workspace.localRoot ?? workspace.rootLabel, "workspace local root")));
  return {
    workspaceRef,
    displayName: optional(workspace.displayName) ?? workspaceRef,
    rootLabel: optional(workspace.rootLabel) ?? localRoot,
    localRoot,
    capabilities: normalizeCapabilities(workspace.capabilities),
  };
}

function workspaceCatalogSnapshot(
  input: ReturnType<typeof normalizePayload>,
): LocalAgentWorkspaceCatalogSnapshot {
  return {
    catalogVersion: input.catalogVersion,
    workspaces: input.workspaces.map((workspace) => ({
      workspaceRef: workspace.workspaceRef,
      displayName: workspace.displayName,
      rootLabel: workspace.rootLabel,
      capabilities: workspace.capabilities,
    })),
  };
}

function capabilitiesFor(workspaces: NormalizedDesktopCloudAgentWorkspace[]): string[] {
  return normalizeCapabilities([
    "mcp-tools",
    ...workspaces.flatMap((workspace) => workspace.capabilities),
  ]);
}

function approvalPromptFor(mode: DesktopCloudAgentApprovalMode | undefined): LocalAgentApprovalPrompt {
  const effectiveMode = mode ?? "desktop_prompt";
  if (effectiveMode === "auto_approve") {
    return {
      requestApproval: (request) => ({
        decision: "approved",
        approvedBy: "desktop-auto-approve",
        reason: `${request.tool} auto-approved by Desktop cloud agent runner policy.`,
      }),
    };
  }

  if (effectiveMode === "desktop_prompt") {
    return {
      requestApproval: (request) => requestNativeDesktopApproval(request),
    };
  }

  return {
    requestApproval: (request) => denyApproval(request),
  };
}

function requestNativeDesktopApproval(request: LocalAgentApprovalRequest): LocalAgentApprovalDecision {
  const message = approvalMessage(request);
  const result = runNativeApprovalDialog(message);
  if (result.approved) {
    return {
      decision: "approved",
      approvedBy: "desktop-native-prompt",
      reason: `${request.tool} approved from the Desktop native approval prompt.`,
    };
  }
  return {
    decision: "denied",
    reason: result.reason ?? `${request.tool} was denied from the Desktop native approval prompt.`,
  };
}

function runNativeApprovalDialog(message: string): { approved: boolean; reason?: string } {
  const currentPlatform = platform();
  if (currentPlatform === "darwin") return runMacApprovalDialog(message);
  if (currentPlatform === "win32") return runWindowsApprovalDialog(message);
  if (currentPlatform === "linux") return runLinuxApprovalDialog(message);
  return { approved: false, reason: `Native approval prompt is not supported on ${currentPlatform}.` };
}

function runMacApprovalDialog(message: string): { approved: boolean; reason?: string } {
  const script = [
    `display dialog ${appleScriptString(message)} buttons {"Deny", "Approve"} default button "Deny" cancel button "Deny" with title "Xautojs Approval" with icon caution`,
  ];
  const result = spawnSync("osascript", ["-e", script.join("\n")], { encoding: "utf8", timeout: 120_000 });
  if (result.error) return { approved: false, reason: `macOS approval prompt failed: ${result.error.message}` };
  if (result.status === 0 && result.stdout.includes("button returned:Approve")) return { approved: true };
  return { approved: false, reason: "macOS approval prompt was denied or dismissed." };
}

function runWindowsApprovalDialog(message: string): { approved: boolean; reason?: string } {
  const script = [
    "Add-Type -AssemblyName PresentationFramework",
    `$result = [System.Windows.MessageBox]::Show(${powershellString(message)}, "Xautojs Approval", "YesNo", "Warning")`,
    "if ($result -eq 'Yes') { exit 0 } else { exit 2 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 120_000 });
  if (result.error) return { approved: false, reason: `Windows approval prompt failed: ${result.error.message}` };
  if (result.status === 0) return { approved: true };
  return { approved: false, reason: "Windows approval prompt was denied or dismissed." };
}

function runLinuxApprovalDialog(message: string): { approved: boolean; reason?: string } {
  const result = spawnSync("zenity", [
    "--question",
    "--title=Xautojs Approval",
    `--text=${message}`,
    "--ok-label=Approve",
    "--cancel-label=Deny",
  ], { encoding: "utf8", timeout: 120_000 });
  if (result.error) return { approved: false, reason: `Linux approval prompt failed: ${result.error.message}` };
  if (result.status === 0) return { approved: true };
  return { approved: false, reason: "Linux approval prompt was denied or dismissed." };
}

function approvalMessage(request: LocalAgentApprovalRequest): string {
  return truncateLines([
    request.title,
    request.message,
    `Tool: ${request.tool}`,
    `Workspace: ${request.workspaceId}`,
    `Risk: ${request.risk}`,
    `Tool call: ${request.toolCallId}`,
    "",
    "Approve only if you trust this ChatGPT session to make this local change.",
  ].filter(Boolean).join("\n"), 1_800);
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}

function powershellString(value: string): string {
  return `@'\n${value.replace(/'@/g, "' + '@") }\n'@`;
}

function truncateLines(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 32)}\n... truncated for approval prompt`;
}

function denyApproval(request: LocalAgentApprovalRequest): LocalAgentApprovalDecision {
  return {
    decision: "denied",
    reason: `${request.tool} requires an interactive Desktop approval prompt before this agent runner can execute it.`,
  };
}

function localAgentServerConfig(allowedRoots: string[]): ServerConfig {
  const roots = allowedRoots.length > 0 ? allowedRoots : [process.cwd()];
  const stateDir = resolve(process.env.DEVSPACE_DESKTOP_AGENT_STATE_DIR ?? ".devspace-desktop-agent");
  return {
    host: "127.0.0.1",
    port: 0,
    deploymentMode: "local",
    oauth: {
      mode: "owner-token",
      ownerToken: "desktop-cloud-agent-local-token",
      accessTokenTtlSeconds: 3_600,
      refreshTokenTtlSeconds: 86_400,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost", "127.0.0.1"],
    },
    database: {
      provider: "sqlite",
      stateDir,
      filePath: `${stateDir}/devspace.sqlite`,
    },
    allowedRoots: roots,
    allowedHosts: ["127.0.0.1", "localhost"],
    publicBaseUrl: "http://127.0.0.1",
    minimalTools: true,
    toolNaming: "short",
    widgets: "off",
    stateDir,
    worktreeRoot: `${stateDir}/worktrees`,
    workspaceSessionTtlSeconds: null,
    workspaceSessionCleanupIntervalSeconds: 3_600,
    skillsEnabled: false,
    skillPaths: [],
    agentDir: `${stateDir}/agent`,
    logging: {
      level: "silent",
      format: "json",
      requests: false,
      assets: false,
      toolCalls: false,
      shellCommands: false,
      trustProxy: false,
    },
  };
}

function workspaceMapKey(context: DevspaceToolExecutionContext, workspaceId: string): string {
  return stableFingerprint({
    tenantId: context.owner.tenantId,
    userId: context.owner.userId,
    mcpSessionId: context.mcpSessionId,
    conversationSessionId: context.conversationSessionId,
    workspaceId,
  });
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set((capabilities ?? ["read"])
    .map((capability) => capability.trim())
    .filter(Boolean))].sort();
}

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required for Desktop cloud agent runner.`);
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
