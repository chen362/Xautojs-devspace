import assert from "node:assert/strict";
import { CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION, type CloudDeviceToolCallMessage } from "./cloud-device-channel-protocol.js";
import {
  LocalAgentToolReceiver,
  type LocalAgentApprovalPrompt,
  type LocalAgentApprovalRequest,
} from "./local-agent-receiver.js";
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

class FakeExecutor implements DevspaceToolExecutor {
  readonly calls: string[] = [];

  async openWorkspace(): Promise<WorkspaceContext> {
    throw new Error("not used");
  }

  async readFile(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ReadFileToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`read:${workspaceId}:${input.path}`);
    return textResponse("read ok");
  }

  async writeFile(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: WriteFileToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`write:${workspaceId}:${input.path}`);
    return textResponse("write ok");
  }

  async editFile(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: EditFileToolInput,
  ): Promise<ToolResponse<EditFileToolDetails>> {
    this.calls.push(`edit:${workspaceId}:${input.path}`);
    return { ...textResponse("edit ok"), details: { diff: "" } };
  }

  async grepFiles(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: GrepFilesToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`grep:${workspaceId}:${input.pattern}`);
    return textResponse("grep ok");
  }

  async findFiles(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: FindFilesToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`find:${workspaceId}:${input.pattern}`);
    return textResponse("find ok");
  }

  async listDirectory(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: ListDirectoryToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`list:${workspaceId}:${input.path}`);
    return textResponse("list ok");
  }

  async runShell(
    _context: DevspaceToolExecutionContext,
    workspaceId: string,
    input: RunShellToolInput,
  ): Promise<ToolResponse> {
    this.calls.push(`shell:${workspaceId}:${input.command}`);
    return textResponse("shell ok");
  }

  async showChanges(_context: DevspaceToolExecutionContext, input: ShowChangesToolInput): Promise<ReviewChangesResult> {
    this.calls.push(`changes:${input.workspaceId}`);
    return { result: "No changes.", summary: { files: 0, additions: 0, removals: 0 }, files: [], patch: "" };
  }
}

class RecordingApprovalPrompt implements LocalAgentApprovalPrompt {
  readonly requests: LocalAgentApprovalRequest[] = [];

  constructor(private readonly decision: "approved" | "denied") {}

  requestApproval(request: LocalAgentApprovalRequest) {
    this.requests.push(request);
    return this.decision === "approved"
      ? { decision: "approved" as const, approvedBy: "test" }
      : { decision: "denied" as const, reason: "not allowed in test" };
  }
}

const context: DevspaceToolExecutionContext = {
  owner: { tenantId: "tenant_approval", userId: "user_approval" },
  mcpSessionId: "mcp_approval",
  conversationSessionId: "conv_approval",
};

const readExecutor = new FakeExecutor();
const readPrompt = new RecordingApprovalPrompt("approved");
const readReceiver = new LocalAgentToolReceiver(readExecutor, { approvalPrompt: readPrompt });
const readResult = await readReceiver.handleToolCall(toolCall("read_file", "tc_read", { path: "README.md" }));
assert.equal(readResult.ok, true);
assert.deepEqual(readPrompt.requests, []);
assert.deepEqual(readExecutor.calls, ["read:ws_approval:README.md"]);

const writeExecutor = new FakeExecutor();
const writePrompt = new RecordingApprovalPrompt("approved");
const writeReceiver = new LocalAgentToolReceiver(writeExecutor, { approvalPrompt: writePrompt });
const writeResult = await writeReceiver.handleToolCall(toolCall("write_file", "tc_write", { path: "notes.txt", content: "hello" }));
assert.equal(writeResult.ok, true);
assert.equal(writePrompt.requests[0]?.tool, "write_file");
assert.equal(writePrompt.requests[0]?.risk, "medium");
assert.deepEqual(writeExecutor.calls, ["write:ws_approval:notes.txt"]);

const shellExecutor = new FakeExecutor();
const shellPrompt = new RecordingApprovalPrompt("denied");
const shellReceiver = new LocalAgentToolReceiver(shellExecutor, { approvalPrompt: shellPrompt });
const shellResult = await shellReceiver.handleToolCall(toolCall("run_shell", "tc_shell", { command: "npm test" }));
if (shellResult.ok) throw new Error("Expected denied shell result.");
assert.equal(shellResult.error.code, "LOCAL_APPROVAL_DENIED");
assert.equal(shellResult.error.retryable, false);
assert.equal(shellPrompt.requests[0]?.risk, "high");
assert.deepEqual(shellExecutor.calls, []);

function toolCall<TInput>(
  tool: CloudDeviceToolCallMessage<TInput>["tool"],
  toolCallId: string,
  input: TInput,
): CloudDeviceToolCallMessage<TInput> {
  return {
    type: "tool.call",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: "dev_approval",
    toolCallId,
    tool,
    context: { ...context, deviceId: "dev_approval", toolCallId },
    workspaceId: "ws_approval",
    input,
  };
}

function textResponse(text: string): ToolResponse {
  return { isError: false, content: [{ type: "text", text }] };
}
