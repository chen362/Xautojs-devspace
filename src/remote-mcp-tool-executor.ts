import { randomUUID } from "node:crypto";
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
  WriteFileToolInput,
} from "./mcp-tool-executor.js";
import type { ToolResponse } from "./pi-tools.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";

export type RemoteMcpToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell"
  | "show_changes";

export interface RemoteMcpToolCall<TInput = unknown> {
  toolCallId: string;
  tool: RemoteMcpToolName;
  context: DevspaceToolExecutionContext;
  workspaceId?: string;
  input: TInput;
}

export interface RemoteMcpToolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export type RemoteMcpToolResult<TResult = unknown> =
  | { ok: true; result: TResult }
  | { ok: false; error: RemoteMcpToolError };

export interface RemoteMcpToolTransport {
  call<TResult = unknown, TInput = unknown>(
    call: RemoteMcpToolCall<TInput>,
  ): Promise<RemoteMcpToolResult<TResult>>;
}

type OpenWorkspaceToolInput = {
  path: string;
  mode?: "checkout" | "worktree";
  baseRef?: string;
};

export class RemoteMcpToolExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(error: RemoteMcpToolError) {
    super(error.message);
    this.name = "RemoteMcpToolExecutionError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
    this.details = error.details;
  }
}

export class RemoteMcpToolExecutor implements DevspaceToolExecutor {
  constructor(private readonly transport: RemoteMcpToolTransport) {}

  openWorkspace(
    context: DevspaceToolExecutionContext,
    input: OpenWorkspaceToolInput,
  ): Promise<WorkspaceContext> {
    return this.callRemote("open_workspace", context, input);
  }

  readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("read_file", context, input, workspaceId);
  }

  writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("write_file", context, input, workspaceId);
  }

  editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    return this.callRemote("edit_file", context, input, workspaceId);
  }

  grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("grep_files", context, input, workspaceId);
  }

  findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("find_files", context, input, workspaceId);
  }

  listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("list_directory", context, input, workspaceId);
  }

  runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    return this.callRemote("run_shell", context, input, workspaceId);
  }

  showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult> {
    return this.callRemote("show_changes", context, input, input.workspaceId);
  }

  private async callRemote<TResult, TInput>(
    tool: RemoteMcpToolName,
    context: DevspaceToolExecutionContext,
    input: TInput,
    workspaceId?: string,
  ): Promise<TResult> {
    this.assertExecutionContext(context);

    const response = await this.transport.call<TResult, TInput>({
      toolCallId: context.toolCallId ?? `tc_${randomUUID()}`,
      tool,
      context,
      workspaceId,
      input,
    });

    if (!response.ok) throw new RemoteMcpToolExecutionError(response.error);
    return response.result;
  }

  private assertExecutionContext(context: DevspaceToolExecutionContext): void {
    if (!context.mcpSessionId.trim()) {
      throw new Error("Missing MCP session execution context.");
    }
    if (!context.owner.tenantId.trim() || !context.owner.userId.trim()) {
      throw new Error("Missing owner execution context.");
    }
  }
}
