import type { WorkspaceIdentity } from "./identity.js";
import type { ToolResponse } from "./pi-tools.js";
import type { ReviewChangesResult, ReviewSince } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";

export interface DevspaceToolExecutionContext {
  mcpSessionId: string;
  owner: WorkspaceIdentity;
  conversationSessionId?: string;
  deviceId?: string;
  toolCallId?: string;
}

export interface ReadFileToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileToolInput {
  path: string;
  content: string;
}

export interface EditFileToolInput {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

export interface EditFileToolDetails {
  diff?: string;
  patch?: string;
}

export interface GrepFilesToolInput {
  pattern: string;
  path?: string;
  include?: string;
}

export interface FindFilesToolInput {
  pattern: string;
  path?: string;
}

export interface ListDirectoryToolInput {
  path: string;
}

export interface RunShellToolInput {
  command: string;
  timeout?: number;
  workingDirectory?: string;
}

export interface ShowChangesToolInput {
  workspaceId: string;
  since?: ReviewSince;
  markReviewed?: boolean;
}

export interface DevspaceToolExecutor {
  openWorkspace(
    context: DevspaceToolExecutionContext,
    input: {
      path: string;
      mode?: "checkout" | "worktree";
      baseRef?: string;
    },
  ): Promise<WorkspaceContext>;
  readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse>;
  writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse>;
  editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>>;
  grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse>;
  findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse>;
  listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse>;
  runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse>;
  showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult>;
}
