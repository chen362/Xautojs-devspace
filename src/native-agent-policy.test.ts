import assert from "node:assert/strict";
import { resolve } from "node:path";
import { classifyNativeToolRisk, evaluateNativeCommandPolicy } from "./native-agent-policy.js";

const workspaceRoot = process.cwd();
const safeNodeCommand = [process.execPath, "-e", "console.log('ok')"];

assert.equal(classifyNativeToolRisk(safeNodeCommand, true), "low");
assert.equal(classifyNativeToolRisk(["rm", "-rf", "dist"], false), "high");
assert.equal(classifyNativeToolRisk(["curl", "https://example.com"], false), "high");

{
  const policy = evaluateNativeCommandPolicy({
    permissionProfile: "read_only",
    argv: safeNodeCommand,
    cwd: workspaceRoot,
    workspaceRoot,
    internal: true,
  });
  assert.equal(policy.decision, "block");
  assert.equal(policy.risk, "medium");
  assert.match(policy.reason, /read-only/i);
}

{
  const policy = evaluateNativeCommandPolicy({
    permissionProfile: "workspace_write",
    argv: safeNodeCommand,
    cwd: workspaceRoot,
    workspaceRoot,
    internal: true,
  });
  assert.equal(policy.decision, "allow");
  assert.equal(policy.risk, "low");
}

{
  const policy = evaluateNativeCommandPolicy({
    permissionProfile: "workspace_write",
    argv: safeNodeCommand,
    cwd: resolve(workspaceRoot, ".."),
    workspaceRoot,
    internal: true,
  });
  assert.equal(policy.decision, "block");
  assert.match(policy.reason, /outside/i);
}

{
  const policy = evaluateNativeCommandPolicy({
    permissionProfile: "workspace_write",
    argv: ["rm", "-rf", "dist"],
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.equal(policy.decision, "block");
  assert.equal(policy.risk, "high");
}

{
  const policy = evaluateNativeCommandPolicy({
    permissionProfile: "trusted_local",
    argv: ["curl", "https://example.com"],
    cwd: workspaceRoot,
    workspaceRoot,
  });
  assert.equal(policy.decision, "audit_only");
  assert.equal(policy.risk, "high");
}
