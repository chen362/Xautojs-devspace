import type { ToolResponse } from "./pi-tools.js";
import type { ReviewChangesResult, ReviewSince } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";

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
  openWorkspace(input: {
    path: string;
    mode?: "checkout" | "worktree";
    baseRef?: string;
  }): Promise<WorkspaceContext>;
  readFile(workspaceId: string, input: ReadFileToolInput): Promise<ToolResponse>;
  writeFile(workspaceId: string, input: WriteFileToolInput): Promise<ToolResponse>;
  editFile(
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>>;
  grepFiles(workspaceId: string, input: GrepFilesToolInput): Promise<ToolResponse>;
  findFiles(workspaceId: string, input: FindFilesToolInput): Promise<ToolResponse>;
  listDirectory(workspaceId: string, input: ListDirectoryToolInput): Promise<ToolResponse>;
  runShell(workspaceId: string, input: RunShellToolInput): Promise<ToolResponse>;
  showChanges(input: ShowChangesToolInput): Promise<ReviewChangesResult>;
}
