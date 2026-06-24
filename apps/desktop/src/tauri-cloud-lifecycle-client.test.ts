import assert from "node:assert/strict";
import type { DesktopCloudLifecyclePayload } from "./cloud-connection-client.js";
import {
  getDesktopCloudLifecycle,
  startDesktopCloudLifecycle,
  stopDesktopCloudLifecycle,
} from "./tauri-cloud-lifecycle-client.js";

interface TestTauriGlobal {
  __TAURI__?: {
    core?: {
      invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    };
  };
}

const globalScope = globalThis as TestTauriGlobal;
const previousTauri = globalScope.__TAURI__;
const payload: DesktopCloudLifecyclePayload = {
  url: "wss://gateway.example.com/cloud/devices/ws",
  authToken: "token-a",
  deviceId: "dev_tauri_a",
  desktopInstanceId: "desk_tauri_a",
  workspaceCatalog: {
    catalogVersion: "catalog-a",
    workspaces: [{
      workspaceRef: "repo-a",
      displayName: "Repo A",
      rootLabel: "~/repo-a",
      capabilities: ["read", "write"],
    }],
  },
};

try {
  delete globalScope.__TAURI__;
  const unsupported = await startDesktopCloudLifecycle(payload);
  assert.equal(unsupported.status, "unsupported");
  assert.equal(unsupported.workspaceCount, 1);

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  globalScope.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "store_cloud_device_token") {
          return undefined as T;
        }
        if (command === "start_cloud_lifecycle") {
          return {
            status: "running",
            deviceId: "dev_tauri_a",
            desktopInstanceId: "desk_tauri_a",
            url: "wss://gateway.example.com/cloud/devices/ws",
            workspaceCount: 1,
            processId: 42,
            startedAt: "unix:1",
          } as T;
        }
        if (command === "stop_cloud_lifecycle") {
          return { status: "stopped", workspaceCount: 1, stoppedAt: "unix:2" } as T;
        }
        return { status: "running", workspaceCount: 1 } as T;
      },
    },
  };

  const running = await startDesktopCloudLifecycle(payload);
  assert.equal(running.status, "running");
  assert.equal(running.deviceId, "dev_tauri_a");
  assert.equal(running.processId, 42);
  assert.equal(calls[0]?.command, "store_cloud_device_token");
  assert.deepEqual(calls[0]?.args, { token: "token-a" });
  assert.equal(calls[1]?.command, "start_cloud_lifecycle");
  assert.deepEqual((calls[1]?.args?.payload as DesktopCloudLifecyclePayload).workspaceCatalog.workspaces[0]?.capabilities, ["read", "write"]);

  const current = await getDesktopCloudLifecycle();
  assert.equal(current.status, "running");
  assert.equal(calls[2]?.command, "get_cloud_lifecycle");

  const stopped = await stopDesktopCloudLifecycle();
  assert.equal(stopped.status, "stopped");
  assert.equal(calls[3]?.command, "stop_cloud_lifecycle");
} finally {
  globalScope.__TAURI__ = previousTauri;
}
