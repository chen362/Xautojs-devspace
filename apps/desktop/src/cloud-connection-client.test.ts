import assert from "node:assert/strict";
import {
  buildDesktopCloudLifecyclePayload,
  cloudConnectionReadiness,
  CLOUD_CONNECTION_STORAGE_KEY,
  normalizeGatewayWsUrl,
  parseWorkspaceCatalogText,
  readCloudConnectionSettings,
  serializeWorkspaceCatalog,
  storeCloudConnectionSettings,
  type DesktopCloudConnectionSettings,
} from "./cloud-connection-client.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

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

const storage = new MemoryStorage();
storeCloudConnectionSettings(settings, storage);
const storedSettings = JSON.parse(storage.getItem(CLOUD_CONNECTION_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
assert.equal(storedSettings.deviceToken, undefined);
assert.equal(storedSettings.gatewayUrl, settings.gatewayUrl);
assert.equal(readCloudConnectionSettings(storage).deviceToken, "");
assert.equal(readCloudConnectionSettings(storage).deviceId, "dev_desktop_a");

assert.equal(cloudConnectionReadiness({ ...settings, deviceToken: "" }), "missing_token");
assert.equal(cloudConnectionReadiness({ ...settings, deviceId: "" }), "missing_device");
