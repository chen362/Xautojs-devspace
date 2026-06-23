import { randomUUID } from "node:crypto";
import {
  createCloudDeviceToolCall,
  type CloudDeviceChannel,
} from "./cloud-device-channel.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
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
import {
  RemoteMcpToolExecutionError,
  type RemoteMcpToolName,
} from "./remote-mcp-tool-executor.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";

type OpenWorkspaceToolInput = {
  path: string;
  mode?: "checkout" | "worktree";
  baseRef?: string;
};

export class GatewayMcpToolExecutor implements DevspaceToolExecutor {
  constructor(
    private readonly routingStore: CloudRoutingStore,
    private readonly deviceChannel: CloudDeviceChannel,
    private readonly sessionBindings: CloudSessionBindingService,
  ) {}

  async openWorkspace(
    context: DevspaceToolExecutionContext,
    input: OpenWorkspaceToolInput,
  ): Promise<WorkspaceContext> {
    const binding = await this.sessionBindings.resolveDevice({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: context.deviceId,
    });
    const toolCallId = this.toolCallId(context);
    const response = await this.deviceChannel.sendToolCall<WorkspaceContext, OpenWorkspaceToolInput>(
      createCloudDeviceToolCall({
        deviceId: binding.deviceId,
        toolCallId,
        tool: "open_workspace",
        context,
        input,
      }),
    );

    if (!response.ok) throw new RemoteMcpToolExecutionError(response.error);

    await this.routingStore.bindWorkspaceRoute({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: binding.deviceId,
      workspaceId: response.result.workspace.id,
      workspaceRef: input.path,
    });

    return response.result;
  }

  readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, ReadFileToolInput>(
      "read_file",
      context,
      workspaceId,
      input,
    );
  }

  writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, WriteFileToolInput>(
      "write_file",
      context,
      workspaceId,
      input,
    );
  }

  editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    return this.callWorkspaceTool<ToolResponse<EditFileToolDetails>, EditFileToolInput>(
      "edit_file",
      context,
      workspaceId,
      input,
    );
  }

  grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, GrepFilesToolInput>(
      "grep_files",
      context,
      workspaceId,
      input,
    );
  }

  findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, FindFilesToolInput>(
      "find_files",
      context,
      workspaceId,
      input,
    );
  }

  listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, ListDirectoryToolInput>(
      "list_directory",
      context,
      workspaceId,
      input,
    );
  }

  runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    return this.callWorkspaceTool<ToolResponse, RunShellToolInput>(
      "run_shell",
      context,
      workspaceId,
      input,
    );
  }

  showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult> {
    return this.callWorkspaceTool<ReviewChangesResult, ShowChangesToolInput>(
      "show_changes",
      context,
      input.workspaceId,
      input,
    );
  }

  private async callWorkspaceTool<TResult, TInput>(
    tool: RemoteMcpToolName,
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: TInput,
  ): Promise<TResult> {
    const toolCallId = this.toolCallId(context);
    const route = await this.routingStore.resolveWorkspaceRoute({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      workspaceId,
      toolCallId,
      tool,
    });

    try {
      const response = await this.deviceChannel.sendToolCall<TResult, TInput>(
        createCloudDeviceToolCall({
          deviceId: route.device.deviceId,
          toolCallId,
          tool,
          context,
          workspaceId,
          input,
        }),
      );

      if (!response.ok) {
        await this.completeToolCall(context, toolCallId, "failed");
        throw new RemoteMcpToolExecutionError(response.error);
      }

      await this.completeToolCall(context, toolCallId, "completed");
      return response.result;
    } catch (error) {
      if (!(error instanceof RemoteMcpToolExecutionError)) {
        await this.completeToolCall(context, toolCallId, "failed");
      }
      throw error;
    }
  }

  private async completeToolCall(
    context: DevspaceToolExecutionContext,
    toolCallId: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    await this.routingStore.completeToolCallRoute({
      owner: context.owner,
      toolCallId,
      status,
    }).catch(() => undefined);
  }

  private toolCallId(context: DevspaceToolExecutionContext): string {
    return context.toolCallId ?? `tc_${randomUUID()}`;
  }
}
