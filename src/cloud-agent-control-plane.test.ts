import assert from "node:assert/strict";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import { LocalAgentToolReceiver } from "./local-agent-receiver.js";
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
import { RemoteMcpToolExecutionError } from "./remote-mcp-tool-executor.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";
import {
  WebSocketDeviceChannel,
  type CloudDeviceConnection,
} from "./websocket-device-channel.js";
import type { CloudDeviceGatewayMessage } from "./cloud-device-channel-protocol.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { WorkspaceContext } from "./workspaces.js";

class LoopbackDeviceConnection implements CloudDeviceConnection {
  readonly sent: CloudDeviceGatewayMessage[] = [];

  constructor(
    private readonly receiver: LocalAgentToolReceiver,
    private readonly channel: WebSocketDeviceChannel,
  ) {}

  async send(message: CloudDeviceGatewayMessage): Promise<void> {
    this.sent.push(message);
    const response = await this.receiver.handleGatewayMessage(message);
    if (response) this.channel.handleDeviceMessage(response);
  }
}

class FakeLocalExecutor implements DevspaceToolExecutor {
  readonly calls: string[] = [];

  async openWorkspace(
    context: DevspaceToolExecutionContext,
    input: { path: string; mode?: "checkout" | "worktree"; baseRef?: string },
  ): Promise<WorkspaceContext> {
    this.calls.push(`open:${context.deviceId}:${input.path}`);
    return workspaceContext(context.owner);
  }

  async readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`read:${context.toolCallId}:${workspaceId}:${input.path}`);
    return textResponse(`read ${input.path}`);
  }

  async writeFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`write:${context.toolCallId}:${workspaceId}:${input.path}:${input.content.length}`);
    return textResponse(`wrote ${input.path}`);
  }

  async editFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    this.calls.push(`edit:${context.toolCallId}:${workspaceId}:${input.path}:${input.edits.length}`);
    return { ...textResponse(`edited ${input.path}`), details: { diff: "" } };
  }

  async grepFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`grep:${context.toolCallId}:${workspaceId}:${input.pattern}`);
    return textResponse("grep result");
  }

  async findFiles(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`find:${context.toolCallId}:${workspaceId}:${input.pattern}`);
    return textResponse("find result");
  }

  async listDirectory(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`list:${context.toolCallId}:${workspaceId}:${input.path}`);
    return textResponse("list result");
  }

  async runShell(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`shell:${context.toolCallId}:${workspaceId}:${input.command}`);
    return textResponse(`ran ${input.command}`);
  }

  async showChanges(
    context: DevspaceToolExecutionContext,
    input: ShowChangesToolInput,
  ): Promise<ReviewChangesResult> {
    this.calls.push(`changes:${context.toolCallId}:${input.workspaceId}`);
    return { result: "No changes.", summary: { files: 0, additions: 0, removals: 0 }, files: [], patch: "" };
  }
}

const owner: WorkspaceIdentity = { tenantId: "tenant_cp", userId: "user_cp" };
const context: DevspaceToolExecutionContext = {
  owner,
  mcpSessionId: "mcp_cp_a",
  conversationSessionId: "conv_cp_a",
};
const routingStore = new InMemoryCloudRoutingStore();
const bindings = new InMemoryCloudSessionBindingService(routingStore);
const channel = new WebSocketDeviceChannel({ toolCallTimeoutMs: 1_000 });
const gateway = new GatewayMcpToolExecutor(routingStore, channel, bindings);
const localExecutor = new FakeLocalExecutor();
const receiver = new LocalAgentToolReceiver(localExecutor);
const connection = new LoopbackDeviceConnection(receiver, channel);

await routingStore.registerDevice({
  owner,
  deviceId: "dev_cp_a",
  capabilities: ["mcp-tools", "shell"],
});
await bindings.bindDevice({
  owner,
  mcpSessionId: context.mcpSessionId,
  conversationSessionId: context.conversationSessionId,
  deviceId: "dev_cp_a",
});
channel.registerConnection({
  deviceId: "dev_cp_a",
  connection,
  capabilities: ["mcp-tools", "shell"],
});

const opened = await gateway.openWorkspace(context, { path: "wsroot_cp_a" });
assert.equal(opened.workspace.id, "mcp_ws_cp_a");
assert.equal(connection.sent[0]?.type, "tool.call");
assert.equal(connection.sent[0]?.tool, "open_workspace");
assert.equal(localExecutor.calls[0], "open:dev_cp_a:wsroot_cp_a");

const read = await gateway.readFile(
  { ...context, toolCallId: "tc_cp_read" },
  opened.workspace.id,
  { path: "README.md" },
);
assert.equal(read.isError, false);
assert.equal(localExecutor.calls.at(-1), "read:tc_cp_read:mcp_ws_cp_a:README.md");
assert.equal((await routingStore.getToolCallRoute(owner, "tc_cp_read"))?.status, "completed");

const write = await gateway.writeFile(
  { ...context, toolCallId: "tc_cp_write" },
  opened.workspace.id,
  { path: "notes.txt", content: "hello" },
);
assert.equal(write.isError, false);
assert.equal(localExecutor.calls.at(-1), "write:tc_cp_write:mcp_ws_cp_a:notes.txt:5");
assert.equal((await routingStore.getToolCallRoute(owner, "tc_cp_write"))?.status, "completed");

const shell = await gateway.runShell(
  { ...context, toolCallId: "tc_cp_shell" },
  opened.workspace.id,
  { command: "npm test" },
);
assert.equal(shell.isError, false);
assert.equal(localExecutor.calls.at(-1), "shell:tc_cp_shell:mcp_ws_cp_a:npm test");
assert.equal((await routingStore.getToolCallRoute(owner, "tc_cp_shell"))?.status, "completed");

await channel.markDeviceOffline({ deviceId: "dev_cp_a", reason: "test_disconnect" });
await assert.rejects(
  () => gateway.readFile(
    { ...context, toolCallId: "tc_cp_disconnected" },
    opened.workspace.id,
    { path: "README.md" },
  ),
  (error: unknown) =>
    error instanceof RemoteMcpToolExecutionError &&
    error.code === "AGENT_DISCONNECTED" &&
    error.retryable === true,
);
assert.equal((await routingStore.getToolCallRoute(owner, "tc_cp_disconnected"))?.status, "failed");

function textResponse(text: string): ToolResponse {
  return { isError: false, content: [{ type: "text", text }] };
}

function workspaceContext(workspaceOwner: WorkspaceIdentity): WorkspaceContext {
  return {
    workspace: {
      id: "mcp_ws_cp_a",
      owner: workspaceOwner,
      root: "/remote/wsroot_cp_a",
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
