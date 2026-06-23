import assert from "node:assert/strict";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import type { ToolResponse } from "./pi-tools.js";
import {
  RemoteMcpToolExecutionError,
  RemoteMcpToolExecutor,
  type RemoteMcpToolCall,
  type RemoteMcpToolResult,
  type RemoteMcpToolTransport,
} from "./remote-mcp-tool-executor.js";
import type { ReviewChangesResult } from "./review-checkpoints.js";
import type { WorkspaceContext } from "./workspaces.js";

const responses: RemoteMcpToolResult<unknown>[] = [];
const calls: RemoteMcpToolCall<unknown>[] = [];
const transport: RemoteMcpToolTransport = {
  async call<TResult, TInput>(
    call: RemoteMcpToolCall<TInput>,
  ): Promise<RemoteMcpToolResult<TResult>> {
    calls.push(call as RemoteMcpToolCall<unknown>);
    const response = responses.shift();
    if (!response) throw new Error(`Missing fake response for ${call.tool}`);

    return response as RemoteMcpToolResult<TResult>;
  },
};
const executor = new RemoteMcpToolExecutor(transport);
const owner = { tenantId: "tenant_a", userId: "user_a" };
const context: DevspaceToolExecutionContext = {
  mcpSessionId: "mcp_session_a",
  owner,
  conversationSessionId: "conv_a",
  deviceId: "dev_a",
  toolCallId: "tc_supplied_open",
};
const scopedContext: DevspaceToolExecutionContext = {
  mcpSessionId: "mcp_session_a",
  owner,
  conversationSessionId: "conv_a",
  deviceId: "dev_a",
};
const workspaceContext: WorkspaceContext = {
  workspace: {
    id: "ws_remote_1",
    owner,
    root: "/remote/workspace-label",
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

responses.push(ok(workspaceContext));
const opened = await executor.openWorkspace(context, {
  path: "/remote/workspace-label",
  mode: "checkout",
});
assert.equal(opened.workspace.id, "ws_remote_1");
assert.equal(calls[0]?.tool, "open_workspace");
assert.equal(calls[0]?.toolCallId, "tc_supplied_open");
assert.equal(calls[0]?.context.mcpSessionId, "mcp_session_a");
assert.equal(calls[0]?.context.owner.tenantId, "tenant_a");
assert.equal(calls[0]?.context.conversationSessionId, "conv_a");
assert.equal(calls[0]?.context.deviceId, "dev_a");
assert.equal(calls[0]?.workspaceId, undefined);
assert.deepEqual(calls[0]?.input, {
  path: "/remote/workspace-label",
  mode: "checkout",
});

responses.push(ok(textResponse("read ok")));
const read = await executor.readFile(scopedContext, "ws_remote_1", {
  path: "src/server.ts",
  limit: 20,
});
assert.equal(read.isError, undefined);
assert.match(read.content[0]?.type === "text" ? read.content[0].text : "", /read ok/);
assert.equal(calls[1]?.tool, "read_file");
assert.match(calls[1]?.toolCallId ?? "", /^tc_/);
assert.equal(calls[1]?.workspaceId, "ws_remote_1");
assert.deepEqual(calls[1]?.input, { path: "src/server.ts", limit: 20 });

const routedToolCalls: Array<{ tool: string; invoke: () => Promise<unknown> }> = [
  {
    tool: "write_file",
    invoke: () => executor.writeFile(scopedContext, "ws_remote_1", {
      path: "README.md",
      content: "updated\n",
    }),
  },
  {
    tool: "edit_file",
    invoke: () => executor.editFile(scopedContext, "ws_remote_1", {
      path: "README.md",
      edits: [{ oldText: "old", newText: "new" }],
    }),
  },
  {
    tool: "grep_files",
    invoke: () => executor.grepFiles(scopedContext, "ws_remote_1", {
      pattern: "RemoteMcpToolExecutor",
      path: "src",
    }),
  },
  {
    tool: "find_files",
    invoke: () => executor.findFiles(scopedContext, "ws_remote_1", {
      pattern: "src/**/*.ts",
    }),
  },
  {
    tool: "list_directory",
    invoke: () => executor.listDirectory(scopedContext, "ws_remote_1", {
      path: "src",
    }),
  },
  {
    tool: "run_shell",
    invoke: () => executor.runShell(scopedContext, "ws_remote_1", {
      command: "npm test",
      timeout: 120,
    }),
  },
];

for (const route of routedToolCalls) {
  responses.push(ok(textResponse(`${route.tool} ok`)));
  await route.invoke();
  assert.equal(calls.at(-1)?.tool, route.tool);
  assert.equal(calls.at(-1)?.workspaceId, "ws_remote_1");
  assert.equal(calls.at(-1)?.context.mcpSessionId, scopedContext.mcpSessionId);
}

const review: ReviewChangesResult = {
  result: "No changes since workspace open.",
  summary: { files: 0, additions: 0, removals: 0 },
  files: [],
  patch: "",
};
responses.push(ok(review));
const changes = await executor.showChanges(scopedContext, {
  workspaceId: "ws_remote_1",
  since: "workspace_open",
  markReviewed: false,
});
assert.equal(changes.summary.files, 0);
assert.equal(calls.at(-1)?.tool, "show_changes");
assert.equal(calls.at(-1)?.workspaceId, "ws_remote_1");
assert.deepEqual(calls.at(-1)?.input, {
  workspaceId: "ws_remote_1",
  since: "workspace_open",
  markReviewed: false,
});

responses.push({
  ok: false,
  error: {
    code: "DEVICE_OFFLINE",
    message: "Device is offline.",
    retryable: true,
    details: { deviceId: "dev_a" },
  },
});
await assert.rejects(
  () => executor.runShell(scopedContext, "ws_remote_1", { command: "npm test" }),
  (error: unknown) =>
    error instanceof RemoteMcpToolExecutionError &&
    error.code === "DEVICE_OFFLINE" &&
    error.retryable === true &&
    error.message === "Device is offline.",
);

await assert.rejects(
  () => executor.readFile({ ...scopedContext, mcpSessionId: "" }, "ws_remote_1", { path: "README.md" }),
  /Missing MCP session execution context\./,
);

function ok<TResult>(result: TResult): RemoteMcpToolResult<TResult> {
  return { ok: true, result };
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}
