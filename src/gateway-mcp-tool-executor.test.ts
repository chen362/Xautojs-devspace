import assert from "node:assert/strict";
import {
  CloudRoutingError,
  type CloudRoutingErrorCode,
} from "./cloud-routing-contract.js";
import {
  type CloudDeviceChannel,
  type CloudDeviceOfflineNotice,
  type CloudDeviceToolCall,
  type CloudDeviceToolCancellation,
} from "./cloud-device-channel.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import type { DevspaceToolExecutionContext, ToolResponse } from "./mcp-tool-executor.js";
import {
  RemoteMcpToolExecutionError,
  type RemoteMcpToolResult,
} from "./remote-mcp-tool-executor.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { WorkspaceContext } from "./workspaces.js";

class FakeCloudDeviceChannel implements CloudDeviceChannel {
  readonly calls: CloudDeviceToolCall<unknown>[] = [];
  readonly cancellations: CloudDeviceToolCancellation[] = [];
  readonly offlineNotices: CloudDeviceOfflineNotice[] = [];
  readonly responses: RemoteMcpToolResult<unknown>[] = [];

  async sendToolCall<TResult, TInput>(
    call: CloudDeviceToolCall<TInput>,
  ): Promise<RemoteMcpToolResult<TResult>> {
    this.calls.push(call as CloudDeviceToolCall<unknown>);
    const response = this.responses.shift();
    if (!response) throw new Error(`Missing fake device response for ${call.tool}`);
    return response as RemoteMcpToolResult<TResult>;
  }

  async cancelToolCall(input: CloudDeviceToolCancellation): Promise<void> {
    this.cancellations.push(input);
  }

  async markDeviceOffline(input: CloudDeviceOfflineNotice): Promise<void> {
    this.offlineNotices.push(input);
  }
}

const owner: WorkspaceIdentity = { tenantId: "tenant_a", userId: "user_a" };
const context: DevspaceToolExecutionContext = {
  owner,
  mcpSessionId: "mcp_gateway_a",
  conversationSessionId: "conv_gateway_a",
};
const store = new InMemoryCloudRoutingStore();
const bindings = new InMemoryCloudSessionBindingService(store);
const channel = new FakeCloudDeviceChannel();
const executor = new GatewayMcpToolExecutor(store, channel, bindings);

await store.registerDevice({
  owner,
  deviceId: "dev_gateway_a",
  label: "Gateway Device A",
  capabilities: ["mcp-tools", "shell"],
});
await bindings.bindDevice({
  owner,
  mcpSessionId: context.mcpSessionId,
  conversationSessionId: context.conversationSessionId,
  deviceId: "dev_gateway_a",
});

channel.responses.push(ok(workspaceContext(owner)));
const opened = await executor.openWorkspace(context, {
  path: "wsroot_xautojs",
  mode: "checkout",
});
assert.equal(opened.workspace.id, "mcp_ws_gateway_a");
assert.equal(channel.calls[0]?.tool, "open_workspace");
assert.equal(channel.calls[0]?.deviceId, "dev_gateway_a");
assert.equal(channel.calls[0]?.context.deviceId, "dev_gateway_a");
assert.equal(channel.calls[0]?.workspaceId, undefined);

channel.responses.push(ok(textResponse("read through gateway")));
const read = await executor.readFile(
  { ...context, toolCallId: "tc_gateway_read" },
  opened.workspace.id,
  { path: "src/server.ts" },
);
assert.equal(read.isError, false);
assert.equal(channel.calls[1]?.tool, "read_file");
assert.equal(channel.calls[1]?.workspaceId, "mcp_ws_gateway_a");
assert.equal(channel.calls[1]?.toolCallId, "tc_gateway_read");
assert.equal(channel.calls[1]?.context.mcpSessionId, context.mcpSessionId);
assert.equal((await store.getToolCallRoute(owner, "tc_gateway_read"))?.status, "completed");

channel.responses.push(ok(textResponse("shell through gateway")));
await executor.runShell(
  { ...context, toolCallId: "tc_gateway_shell" },
  opened.workspace.id,
  { command: "npm test" },
);
assert.equal(channel.calls.at(-1)?.tool, "run_shell");
assert.equal((await store.getToolCallRoute(owner, "tc_gateway_shell"))?.status, "completed");

channel.responses.push({
  ok: false,
  error: {
    code: "LOCAL_POLICY_BLOCKED",
    message: "Desktop policy denied this write.",
    retryable: false,
  },
});
await assert.rejects(
  () => executor.writeFile(
    { ...context, toolCallId: "tc_gateway_write_denied" },
    opened.workspace.id,
    { path: "README.md", content: "blocked\n" },
  ),
  (error: unknown) =>
    error instanceof RemoteMcpToolExecutionError &&
    error.code === "LOCAL_POLICY_BLOCKED" &&
    error.retryable === false,
);
assert.equal((await store.getToolCallRoute(owner, "tc_gateway_write_denied"))?.status, "failed");

await store.setDeviceStatus({ owner, deviceId: "dev_gateway_a", status: "offline" });
const callsBeforeOfflineRead = channel.calls.length;
await assertRoutingError(
  () => executor.readFile(
    { ...context, toolCallId: "tc_gateway_offline" },
    opened.workspace.id,
    { path: "src/server.ts" },
  ),
  "DEVICE_OFFLINE",
  true,
);
assert.equal(channel.calls.length, callsBeforeOfflineRead);

await assertRoutingError(
  () => executor.openWorkspace(
    {
      owner,
      mcpSessionId: "mcp_unpaired",
      conversationSessionId: "conv_unpaired",
    },
    { path: "wsroot_missing" },
  ),
  "PAIRING_REQUIRED",
);

function ok<TResult>(result: TResult): RemoteMcpToolResult<TResult> {
  return { ok: true, result };
}

function textResponse(text: string): ToolResponse {
  return { isError: false, content: [{ type: "text", text }] };
}

function workspaceContext(workspaceOwner: WorkspaceIdentity): WorkspaceContext {
  return {
    workspace: {
      id: "mcp_ws_gateway_a",
      owner: workspaceOwner,
      root: "/remote/wsroot_xautojs",
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

async function assertRoutingError(
  action: () => Promise<unknown>,
  code: CloudRoutingErrorCode,
  retryable = false,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof CloudRoutingError &&
      error.code === code &&
      error.retryable === retryable,
  );
}
