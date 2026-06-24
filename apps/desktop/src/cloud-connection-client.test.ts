import assert from "node:assert/strict";
import {
  buildDesktopCloudLifecyclePayload,
  cloudConnectionReadiness,
  normalizeGatewayWsUrl,
  parseWorkspaceCatalogText,
  serializeWorkspaceCatalog,
  type DesktopCloudConnectionSettings,
} from "./cloud-connection-client.js";

assert.equal(normalizeGatewayWsUrl("https://gateway.example.com/cloud/devices/ws/"), "wss://gateway.example.com/cloud/devices/ws");
assert.equal(normalizeGatewayWsUrl("gateway.example.com/cloud/devices/ws"), "wss://gateway.example.com/cloud/devices/ws");
assert.equal(normalizeGatewayWsUrl("http://127.0.0.1:8787/cloud/devices/ws"), "ws://127.0.0.1:8787/cloud/devices/ws");

const workspaces = parseWorkspaceCatalogText(`
repo-b | Beta Repo | ~/repo-b | write, read, read
repo-a | Alpha Repo | ~/repo-a | read
`);
assert.deepEqual(workspaces.map((workspace) => workspace.workspaceRef), ["repo-a", "repo-b"]);
assert.deepEqual(workspaces[1]?.capabilities, ["read", "write"]);
assert.equal(serializeWorkspaceCatalog(workspaces), "repo-a | Alpha Repo | ~/repo-a | read\nrepo-b | Beta Repo | ~/repo-b | read,write");

const settings: DesktopCloudConnectionSettings = {
  gatewayUrl: "https://gateway.example.com/cloud/devices/ws/",
  deviceId: "dev_desktop_a",
  desktopInstanceId: "desk_desktop_a",
  deviceToken: "token-a",
  workspaceCatalogText: "repo-a | Alpha Repo | ~/repo-a | read",
};
assert.equal(cloudConnectionReadiness(settings), "ready");
const payload = buildDesktopCloudLifecyclePayload(settings);
assert.equal(payload.url, "wss://gateway.example.com/cloud/devices/ws");
assert.equal(payload.authToken, "token-a");
assert.equal(payload.workspaceCatalog.workspaces[0]?.workspaceRef, "repo-a");

assert.equal(cloudConnectionReadiness({ ...settings, deviceToken: "" }), "missing_token");
assert.equal(cloudConnectionReadiness({ ...settings, deviceId: "" }), "missing_device");
