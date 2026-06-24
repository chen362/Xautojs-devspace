import type {
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

export class LocalAgentToolReceiver {
  constructor(private readonly executor: DevspaceToolExecutor) {}

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

  private executeToolCall(
    message: Extract<CloudDeviceGatewayMessage, { type: "tool.call" }>,
  ): Promise<unknown> {
    switch (message.tool) {
      case "open_workspace":
        return this.executor.openWorkspace(message.context, message.input as OpenWorkspaceToolInput);
      case "read_file":
        return this.executor.readFile(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as ReadFileToolInput,
        );
      case "write_file":
        return this.executor.writeFile(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as WriteFileToolInput,
        );
      case "edit_file":
        return this.executor.editFile(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as EditFileToolInput,
        );
      case "grep_files":
        return this.executor.grepFiles(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as GrepFilesToolInput,
        );
      case "find_files":
        return this.executor.findFiles(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as FindFilesToolInput,
        );
      case "list_directory":
        return this.executor.listDirectory(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as ListDirectoryToolInput,
        );
      case "run_shell":
        return this.executor.runShell(
          message.context,
          requiredWorkspaceId(message.workspaceId),
          message.input as RunShellToolInput,
        );
      case "show_changes":
        return this.executor.showChanges(message.context, message.input as ShowChangesToolInput);
    }
  }
}

function requiredWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId?.trim()) throw new Error("workspaceId is required for this tool call.");
  return workspaceId;
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
