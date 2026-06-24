import assert from "node:assert/strict";
import {
  clearDesktopCloudDeviceToken,
  readDesktopCloudDeviceToken,
  storeDesktopCloudDeviceToken,
} from "./tauri-cloud-token-client.js";

interface TestTauriGlobal {
  __TAURI__?: {
    core?: {
      invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
    };
  };
}

const globalScope = globalThis as TestTauriGlobal;
const previousTauri = globalScope.__TAURI__;

try {
  delete globalScope.__TAURI__;
  const unsupported = await readDesktopCloudDeviceToken();
  assert.equal(unsupported.status, "unsupported");

  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  globalScope.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "read_cloud_device_token") return "token-a" as T;
        return undefined as T;
      },
    },
  };

  const stored = await storeDesktopCloudDeviceToken("token-a");
  assert.equal(stored.status, "ready");
  assert.equal(calls[0]?.command, "store_cloud_device_token");
  assert.deepEqual(calls[0]?.args, { token: "token-a" });

  const read = await readDesktopCloudDeviceToken();
  assert.equal(read.status, "ready");
  assert.equal(read.token, "token-a");
  assert.equal(calls[1]?.command, "read_cloud_device_token");

  const cleared = await clearDesktopCloudDeviceToken();
  assert.equal(cleared.status, "empty");
  assert.equal(calls[2]?.command, "clear_cloud_device_token");

  globalScope.__TAURI__ = {
    core: {
      invoke: async <T>(command: string) => {
        if (command === "read_cloud_device_token") return null as T;
        throw new Error("unexpected command");
      },
    },
  };
  assert.equal((await readDesktopCloudDeviceToken()).status, "empty");
} finally {
  globalScope.__TAURI__ = previousTauri;
}
