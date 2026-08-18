import assert from "node:assert/strict";
import type { RawData } from "ws";
import { LocalAgentOutboundClient, type LocalAgentSocket } from "./local-agent-outbound-client.js";
import { LocalAgentToolReceiver } from "./local-agent-receiver.js";
import {
  CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  type CloudDeviceGatewayMessage,
} from "./cloud-device-channel-protocol.js";
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

class FakeSocket implements LocalAgentSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

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
  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emitOpen(): void {
    this.emit("open");
  }

  receive(message: CloudDeviceGatewayMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeExecutor implements DevspaceToolExecutor {
  async openWorkspace(): Promise<WorkspaceContext> {
    throw new Error("not used");
  }

  async readFile(
    context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    return {
      isError: false,
      content: [{ type: "text", text: `${context.deviceId}:${workspaceId}:${input.path}` }],
    };
  }

  async writeFile(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: WriteFileToolInput): Promise<ToolResponse> {
    return { isError: false, content: [{ type: "text", text: "write" }] };
  }

  async editFile(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: EditFileToolInput): Promise<ToolResponse<EditFileToolDetails>> {
    return { isError: false, content: [{ type: "text", text: "edit" }], details: {} };
  }

  async grepFiles(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: GrepFilesToolInput): Promise<ToolResponse> {
    return { isError: false, content: [{ type: "text", text: "grep" }] };
  }

  async findFiles(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: FindFilesToolInput): Promise<ToolResponse> {
    return { isError: false, content: [{ type: "text", text: "find" }] };
  }

  async listDirectory(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: ListDirectoryToolInput): Promise<ToolResponse> {
    return { isError: false, content: [{ type: "text", text: "list" }] };
  }

  async runShell(_context: DevspaceToolExecutionContext, _workspaceId: string, _input: RunShellToolInput): Promise<ToolResponse> {
    return { isError: false, content: [{ type: "text", text: "shell" }] };
  }

  async showChanges(_context: DevspaceToolExecutionContext, input: ShowChangesToolInput): Promise<ReviewChangesResult> {
    return { result: input.workspaceId, summary: { files: 0, additions: 0, removals: 0 }, files: [], patch: "" };
  }
}

let socket: FakeSocket | undefined;
const receiver = new LocalAgentToolReceiver(new FakeExecutor());
const client = new LocalAgentOutboundClient({
  url: "wss://gateway.example.com/cloud/devices/ws",
  deviceId: "dev_client_a",
  desktopInstanceId: "desk_client_a",
  agentVersion: "1.2.3",
  capabilities: ["shell", "mcp-tools"],
  receiver,
  heartbeatIntervalMs: 20,
  workspaceCatalogProvider: () => ({
    catalogVersion: "catalog_client_v1",
    workspaces: [{
      workspaceRef: "workspace_client_a",
      displayName: "Client Workspace",
      rootLabel: "~/client",
      capabilities: ["read", "write"],
    }],
  }),
  now: () => "2026-06-24T00:00:00.000Z",
  socketFactory: () => {
    socket = new FakeSocket();
    return socket;
  },
});

client.start();
assert.ok(socket);
socket.emitOpen();
assert.equal(JSON.parse(socket.sent[0] ?? "{}").type, "agent.hello");
assert.equal(JSON.parse(socket.sent[0] ?? "{}").deviceId, "dev_client_a");

await waitFor(() => socket?.sent.some((message) => JSON.parse(message).type === "workspace.catalog") ?? false);
const catalog = socket.sent.map((message) => JSON.parse(message)).find((message) => message.type === "workspace.catalog");
assert.equal(catalog.catalogVersion, "catalog_client_v1");
assert.equal(catalog.workspaces[0].workspaceRef, "workspace_client_a");

socket.receive({
  type: "tool.call",
  protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  deviceId: "dev_client_a",
  toolCallId: "tc_client_read",
  tool: "read_file",
  context: {
    owner: { tenantId: "tenant_client", userId: "user_client" },
    mcpSessionId: "mcp_client_a",
    conversationSessionId: "conv_client_a",
  },
  workspaceId: "mcp_ws_client_a",
  input: { path: "README.md" },
});
await waitFor(() => socket?.sent.some((message) => JSON.parse(message).type === "tool.result") ?? false);
const result = socket.sent.map((message) => JSON.parse(message)).find((message) => message.type === "tool.result");
assert.equal(result.ok, true);
assert.equal(result.toolCallId, "tc_client_read");
assert.equal(result.result.content[0].text, "dev_client_a:mcp_ws_client_a:README.md");

await waitFor(() => socket?.sent.some((message) => JSON.parse(message).type === "agent.heartbeat") ?? false);
client.stop();
assert.equal(socket.readyState, 3);

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
