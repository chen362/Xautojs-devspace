import type {
  DevspaceToolExecutionContext,
  DevspaceToolExecutor,
  EditFileToolInput,
  FindFilesToolInput,
  GrepFilesToolInput,
  ListDirectoryToolInput,
  ReadFileToolInput,
  RunShellToolInput,
  ShowChangesToolInput,
  WriteFileToolInput,
} from "./mcp-tool-executor.js";
import {
  createCloudDeviceToolErrorMessage,
  createCloudDeviceToolResultMessage,
  type CloudDeviceGatewayMessage,
  type CloudDeviceToolResultMessage,
} from "./cloud-device-channel-protocol.js";
import type { RemoteMcpToolError } from "./remote-mcp-tool-executor.js";

type OpenWorkspaceToolInput = {
  path: string;
  mode?: "checkout" | "worktree";
  baseRef?: string;
};

export type LocalAgentApprovalToolName = "write_file" | "edit_file" | "run_shell";
export type LocalAgentApprovalRisk = "medium" | "high";

export interface LocalAgentApprovalRequest<TInput = unknown> {
  toolCallId: string;
  tool: LocalAgentApprovalToolName;
  workspaceId: string;
  context: DevspaceToolExecutionContext;
  input: TInput;
  risk: LocalAgentApprovalRisk;
  title: string;
  message: string;
}

export interface LocalAgentApprovalDecision {
  decision: "approved" | "denied";
  reason?: string;
  approvedBy?: string;
}

export interface LocalAgentApprovalPrompt {
  requestApproval<TInput = unknown>(
    request: LocalAgentApprovalRequest<TInput>,
  ): Promise<LocalAgentApprovalDecision> | LocalAgentApprovalDecision;
}

export interface LocalAgentToolReceiverOptions {
  approvalPrompt?: LocalAgentApprovalPrompt;
}

export class LocalAgentApprovalDeniedError extends Error {
  readonly code = "LOCAL_APPROVAL_DENIED";
  readonly retryable = false;
  readonly details: { tool: LocalAgentApprovalToolName; toolCallId: string; workspaceId: string; reason?: string };

  constructor(input: {
    tool: LocalAgentApprovalToolName;
    toolCallId: string;
    workspaceId: string;
    reason?: string;
  }) {
    super(input.reason ? `Local approval denied: ${input.reason}` : "Local approval denied.");
    this.name = "LocalAgentApprovalDeniedError";
    this.details = input;
  }
}

export class LocalAgentToolReceiver {
  constructor(
    private readonly executor: DevspaceToolExecutor,
    private readonly options: LocalAgentToolReceiverOptions = {},
  ) {}

  async handleGatewayMessage(
    message: CloudDeviceGatewayMessage,
  ): Promise<CloudDeviceToolResultMessage | undefined> {
    if (message.type === "tool.cancel") return undefined;
    return this.handleToolCall(message);
  }

  async handleToolCall(
    message: Extract<CloudDeviceGatewayMessage, { type: "tool.call" }>,
  ): Promise<CloudDeviceToolResultMessage> {
    try {
      const result = await this.executeToolCall(message);
      return createCloudDeviceToolResultMessage({
        deviceId: message.deviceId,
        toolCallId: message.toolCallId,
        result,
      });
    } catch (error) {
      return createCloudDeviceToolErrorMessage({
        deviceId: message.deviceId,
        toolCallId: message.toolCallId,
        error: localAgentError(error),
      });
    }
  }

  private async executeToolCall(
    message: Extract<CloudDeviceGatewayMessage, { type: "tool.call" }>,
  ): Promise<unknown> {
    const context: DevspaceToolExecutionContext = {
      ...message.context,
      deviceId: message.deviceId,
      toolCallId: message.toolCallId,
    };

    switch (message.tool) {
      case "open_workspace":
        return this.executor.openWorkspace(context, message.input as OpenWorkspaceToolInput);
      case "read_file":
        return this.executor.readFile(
          context,
          requiredWorkspaceId(message.workspaceId),
          message.input as ReadFileToolInput,
        );
      case "write_file": {
        const workspaceId = requiredWorkspaceId(message.workspaceId);
        const input = message.input as WriteFileToolInput;
        await this.requireApproval(message, "write_file", workspaceId, input, "medium", writeApprovalTitle(input));
        return this.executor.writeFile(context, workspaceId, input);
      }
      case "edit_file": {
        const workspaceId = requiredWorkspaceId(message.workspaceId);
        const input = message.input as EditFileToolInput;
        await this.requireApproval(message, "edit_file", workspaceId, input, "medium", editApprovalTitle(input));
        return this.executor.editFile(context, workspaceId, input);
      }
      case "grep_files":
        return this.executor.grepFiles(
          context,
          requiredWorkspaceId(message.workspaceId),
          message.input as GrepFilesToolInput,
        );
      case "find_files":
        return this.executor.findFiles(
          context,
          requiredWorkspaceId(message.workspaceId),
          message.input as FindFilesToolInput,
        );
      case "list_directory":
        return this.executor.listDirectory(
          context,
          requiredWorkspaceId(message.workspaceId),
          message.input as ListDirectoryToolInput,
        );
      case "run_shell": {
        const workspaceId = requiredWorkspaceId(message.workspaceId);
        const input = message.input as RunShellToolInput;
        await this.requireApproval(message, "run_shell", workspaceId, input, "high", shellApprovalTitle(input));
        return this.executor.runShell(context, workspaceId, input);
      }
      case "show_changes":
        return this.executor.showChanges(context, message.input as ShowChangesToolInput);
    }
  }

  private async requireApproval<TInput>(
    message: Extract<CloudDeviceGatewayMessage, { type: "tool.call" }>,
    tool: LocalAgentApprovalToolName,
    workspaceId: string,
    input: TInput,
    risk: LocalAgentApprovalRisk,
    title: string,
  ): Promise<void> {
    const prompt = this.options.approvalPrompt;
    if (!prompt) return;

    const decision = await prompt.requestApproval({
      toolCallId: message.toolCallId,
      tool,
      workspaceId,
      context: {
        ...message.context,
        deviceId: message.deviceId,
        toolCallId: message.toolCallId,
      },
      input,
      risk,
      title,
      message: `${title} in workspace ${workspaceId}.`,
    });
    if (decision.decision === "approved") return;

    throw new LocalAgentApprovalDeniedError({
      tool,
      toolCallId: message.toolCallId,
      workspaceId,
      reason: decision.reason,
    });
  }
}

function requiredWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId?.trim()) throw new Error("workspaceId is required for this tool call.");
  return workspaceId;
}

function writeApprovalTitle(input: WriteFileToolInput): string {
  return `Write ${input.path}`;
}

function editApprovalTitle(input: EditFileToolInput): string {
  return `Edit ${input.path}`;
}

function shellApprovalTitle(input: RunShellToolInput): string {
  const command = input.command.length > 80 ? `${input.command.slice(0, 77)}...` : input.command;
  return `Run shell command: ${command}`;
}

function localAgentError(error: unknown): RemoteMcpToolError {
  const maybeError = error as { code?: unknown; retryable?: unknown; details?: unknown };
  return {
    code: typeof maybeError.code === "string" ? maybeError.code : "LOCAL_TOOL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: typeof maybeError.retryable === "boolean" ? maybeError.retryable : false,
    details: maybeError.details,
  };
}
