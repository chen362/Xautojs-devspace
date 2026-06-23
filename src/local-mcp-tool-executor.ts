import type { ServerConfig } from "./config.js";
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
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  type ToolResponse,
  writeFileTool,
} from "./pi-tools.js";
import type { ReviewCheckpointManager, ReviewChangesResult } from "./review-checkpoints.js";
import type { WorkspaceContext, WorkspaceRegistry } from "./workspaces.js";

export class LocalMcpToolExecutor implements DevspaceToolExecutor {
  constructor(
    private readonly config: ServerConfig,
    private readonly workspaces: WorkspaceRegistry,
    private readonly reviewCheckpoints: ReviewCheckpointManager,
  ) {}

  async openWorkspace(
    context: DevspaceToolExecutionContext,
    input: {
      path: string;
      mode?: "checkout" | "worktree";
      baseRef?: string;
    },
  ): Promise<WorkspaceContext> {
    this.assertExecutionContext(context);
    const workspaceContext = await this.workspaces.openWorkspace(input);

    if (this.config.widgets === "changes") {
      void this.reviewCheckpoints.initializeWorkspace({
        workspaceId: workspaceContext.workspace.id,
        root: workspaceContext.workspace.root,
      });
    }

    return workspaceContext;
  }

  async readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    const readPath = this.workspaces.resolveReadPath(workspace, input.path);
    const response = await readFileTool(
      { ...input, path: readPath.absolutePath },
      {
        cwd: workspace.root,
        root: workspace.root,
        readRoots: readPath.readRoots,
      },
    );

    if (!response.isError) {
      this.workspaces.markReadPathLoaded(workspace, readPath);
    }

    return response;
  }

  async writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    this.workspaces.resolvePath(workspace, input.path);

    return writeFileTool(input, {
      cwd: workspace.root,
      root: workspace.root,
    });
  }

  async editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    this.workspaces.resolvePath(workspace, input.path);

    return editFileTool(input, {
      cwd: workspace.root,
      root: workspace.root,
    }) as Promise<ToolResponse<EditFileToolDetails>>;
  }

  async grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    if (input.path) this.workspaces.resolvePath(workspace, input.path);

    return grepFilesTool(input, {
      cwd: workspace.root,
      root: workspace.root,
    });
  }

  async findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    if (input.path) this.workspaces.resolvePath(workspace, input.path);

    return findFilesTool(input, {
      cwd: workspace.root,
      root: workspace.root,
    });
  }

  async listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    this.workspaces.resolvePath(workspace, input.path);

    return listDirectoryTool(input, {
      cwd: workspace.root,
      root: workspace.root,
    });
  }

  async runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(workspaceId);
    const cwd = this.workspaces.resolveWorkingDirectory(
      workspace,
      input.workingDirectory,
    );

    return runShellTool(
      {
        command: input.command,
        timeout: input.timeout,
      },
      {
        cwd,
        root: workspace.root,
      },
    );
  }

  async showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult> {
    this.assertExecutionContext(context);
    const workspace = await this.workspaces.getWorkspace(input.workspaceId);

    return this.reviewCheckpoints.reviewChanges({
      workspaceId: input.workspaceId,
      root: workspace.root,
      since: input.since ?? "last_shown",
      markReviewed: input.markReviewed ?? true,
    });
  }

  private assertExecutionContext(context: DevspaceToolExecutionContext): void {
    if (!context.mcpSessionId.trim()) {
      throw new Error("Missing MCP session execution context.");
    }
  }
}
