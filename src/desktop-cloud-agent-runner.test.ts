import assert from "node:assert/strict";
import type { RawData } from "ws";
import {
  DesktopCloudWorkspaceExecutor,
  deterministicCloudWorkspaceId,
  startDesktopCloudAgentFromPayload,
} from "./desktop-cloud-agent-runner.js";
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
import type { ReviewChangesResult } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";
import type { LocalAgentSocket } from "./local-agent-outbound-client.js";
import type { WorkspaceIdentity } from "./identity.js";

class FakeSocket implements LocalAgentSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from("closed"));
  }

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emitOpen(): void {
    this.emit("open");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeExecutor implements DevspaceToolExecutor {
  readonly calls: string[] = [];
  private nextWorkspaceIndex = 0;

  async openWorkspace(
    context: DevspaceToolExecutionContext,
    input: { path: string; mode?: "checkout" | "worktree"; baseRef?: string },
  ): Promise<WorkspaceContext> {
    this.calls.push(`open:${context.mcpSessionId}:${input.path}`);
    this.nextWorkspaceIndex += 1;
    return workspaceContext(`local_ws_${this.nextWorkspaceIndex}`, input.path, context.owner);
  }

  async readFile(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`read:${workspaceId}:${input.path}`);
    return textResponse("read ok");
  }

  async writeFile(_context: DevspaceToolExecutionContext, workspaceId: string, input: WriteFileToolInput): Promise<ToolResponse> {
    this.calls.push(`write:${workspaceId}:${input.path}`);
    return textResponse("write ok");
  }

  async editFile(_context: DevspaceToolExecutionContext, workspaceId: string, input: EditFileToolInput): Promise<ToolResponse<EditFileToolDetails>> {
    this.calls.push(`edit:${workspaceId}:${input.path}`);
    return { ...textResponse("edit ok"), details: { diff: "" } };
  }

  async grepFiles(_context: DevspaceToolExecutionContext, workspaceId: string, input: GrepFilesToolInput): Promise<ToolResponse> {
    this.calls.push(`grep:${workspaceId}:${input.pattern}`);
    return textResponse("grep ok");
  }

  async findFiles(_context: DevspaceToolExecutionContext, workspaceId: string, input: FindFilesToolInput): Promise<ToolResponse> {
    this.calls.push(`find:${workspaceId}:${input.pattern}`);
    return textResponse("find ok");
  }

  async listDirectory(_context: DevspaceToolExecutionContext, workspaceId: string, input: ListDirectoryToolInput): Promise<ToolResponse> {
    this.calls.push(`list:${workspaceId}:${input.path}`);
    return textResponse("list ok");
  }

  async runShell(_context: DevspaceToolExecutionContext, workspaceId: string, input: RunShellToolInput): Promise<ToolResponse> {
    this.calls.push(`shell:${workspaceId}:${input.command}`);
    return textResponse("shell ok");
  }

  async showChanges(_context: DevspaceToolExecutionContext, input: ShowChangesToolInput): Promise<ReviewChangesResult> {
    this.calls.push(`changes:${input.workspaceId}`);
    return { result: "No changes.", summary: { files: 0, additions: 0, removals: 0 }, files: [], patch: "" };
  }
}

const owner: WorkspaceIdentity = { tenantId: "tenant_desktop_runner", userId: "user_desktop_runner" };
const context: DevspaceToolExecutionContext = {
  owner,
  mcpSessionId: "mcp_desktop_runner",
  conversationSessionId: "conv_desktop_runner",
  deviceId: "dev_desktop_runner",
};
const cloudWorkspaceId = deterministicCloudWorkspaceId({
  tenantId: owner.tenantId,
  userId: owner.userId,
  mcpSessionId: context.mcpSessionId,
  conversationSessionId: context.conversationSessionId,
  deviceId: context.deviceId!,
  workspaceRef: "workspace_runner_a",
});
const fakeExecutor = new FakeExecutor();
const executor = new DesktopCloudWorkspaceExecutor(fakeExecutor, {
  deviceId: "dev_desktop_runner",
  workspaces: [{
    workspaceRef: "workspace_runner_a",
    displayName: "Runner A",
    rootLabel: "/tmp/runner-a",
    localRoot: "/tmp/runner-a",
    capabilities: ["read", "write"],
  }],
});

await executor.readFile(context, cloudWorkspaceId, { path: "README.md" });
await executor.writeFile(context, cloudWorkspaceId, { path: "notes.txt", content: "hello" });
assert.deepEqual(fakeExecutor.calls, [
  "open:mcp_desktop_runner:/tmp/runner-a",
  "read:local_ws_1:README.md",
  "write:local_ws_1:notes.txt",
]);

const sockets: FakeSocket[] = [];
const started = startDesktopCloudAgentFromPayload({
  url: "wss://gateway.example.com/cloud/devices/ws",
  authToken: "desktop-token",
  deviceId: "dev_desktop_runner",
  desktopInstanceId: "desk_desktop_runner",
  workspaceCatalog: {
    catalogVersion: "catalog_desktop_runner",
    workspaces: [{
      workspaceRef: "workspace_runner_a",
      displayName: "Runner A",
      rootLabel: "/tmp/runner-a",
      capabilities: ["read", "write"],
    }],
  },
}, {
  approvalMode: "auto_approve",
  now: () => "2026-06-24T00:00:00.000Z",
  socketFactory: (_url, _options) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
});
assert.equal(started.snapshot.status, "running");
sockets[0]?.emitOpen();
await waitFor(() => sockets[0]?.sent.some((message) => JSON.parse(message).type === "workspace.catalog") ?? false);
assert.equal(JSON.parse(sockets[0]?.sent[0] ?? "{}").type, "agent.hello");
const catalog = JSON.parse(sockets[0]?.sent.find((message) => JSON.parse(message).type === "workspace.catalog") ?? "{}");
assert.equal(catalog.catalogVersion, "catalog_desktop_runner");
assert.equal(catalog.workspaces[0]?.workspaceRef, "workspace_runner_a");
assert.equal(catalog.workspaces[0]?.rootLabel, "/tmp/runner-a");
started.lifecycle.stop();

function textResponse(text: string): ToolResponse {
  return { isError: false, content: [{ type: "text", text }] };
}

function workspaceContext(id: string, root: string, workspaceOwner: WorkspaceIdentity): WorkspaceContext {
  return {
    workspace: {
      id,
      owner: workspaceOwner,
      root,
      mode: "checkout",
      skills: [],
      skillDiagnostics: [],
      agentsFiles: [],
      availableAgentsFiles: [],
      activatedSkillDirs: new Set(),
    },
    agentsFiles: [],
    availableAgentsFiles: [],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
