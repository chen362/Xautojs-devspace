import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { LOCAL_WORKSPACE_IDENTITY } from "./identity.js";
import { LocalMcpToolExecutor } from "./local-mcp-tool-executor.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-local-executor-test-"));

try {
  const agentDir = join(root, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(root, "AGENTS.md"), "workspace instructions\n");
  await writeFile(join(root, "input.txt"), "hello executor\n");

  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_AGENT_DIR: agentDir,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const context: DevspaceToolExecutionContext = {
    mcpSessionId: "mcp_session_local_executor",
    owner: LOCAL_WORKSPACE_IDENTITY,
  };
  const registry = new WorkspaceRegistry(
    config,
    undefined,
    LOCAL_WORKSPACE_IDENTITY,
    { mcpSessionId: context.mcpSessionId },
  );
  const executor = new LocalMcpToolExecutor(
    config,
    registry,
    createReviewCheckpointManager(),
  );

  const opened = await executor.openWorkspace(context, { path: root });
  assert.equal(opened.workspace.root, root);
  assert.equal(opened.workspace.mode, "checkout");

  const read = await executor.readFile(context, opened.workspace.id, { path: "input.txt" });
  assert.equal(read.isError, false);
  assert.match(responseText(read.content), /hello executor/);

  const outputPath = join(root, "output.txt");
  const write = await executor.writeFile(context, opened.workspace.id, {
    path: "output.txt",
    content: "created\n",
  });
  assert.equal(write.isError, false);
  assert.equal(await readFile(outputPath, "utf8"), "created\n");

  const edit = await executor.editFile(context, opened.workspace.id, {
    path: "output.txt",
    edits: [{ oldText: "created\n", newText: "edited\n" }],
  });
  assert.equal(edit.isError, false);
  assert.equal(await readFile(outputPath, "utf8"), "edited\n");

  const shell = await executor.runShell(context, opened.workspace.id, {
    command: "printf executor-shell",
  });
  assert.equal(shell.isError, false);
  assert.match(responseText(shell.content), /executor-shell/);
} finally {
  await rm(root, { recursive: true, force: true });
}

function responseText(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
