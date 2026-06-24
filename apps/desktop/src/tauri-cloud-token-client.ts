export type DesktopCloudTokenBridgeStatus = "unsupported" | "ready" | "empty" | "error";

export interface DesktopCloudTokenBridgeSnapshot {
  status: DesktopCloudTokenBridgeStatus;
  token?: string;
  lastError?: string;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriGlobalScope {
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
  };
}

export async function storeDesktopCloudDeviceToken(token: string): Promise<DesktopCloudTokenBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot();

  try {
    await invoke<void>("store_cloud_device_token", { token });
    return { status: "ready" };
  } catch (error) {
    return errorSnapshot(error);
  }
}

export async function readDesktopCloudDeviceToken(): Promise<DesktopCloudTokenBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot();

  try {
    const token = await invoke<string | null>("read_cloud_device_token");
    const normalized = optionalString(token);
    return normalized ? { status: "ready", token: normalized } : { status: "empty" };
  } catch (error) {
    return errorSnapshot(error);
  }
}

export async function clearDesktopCloudDeviceToken(): Promise<DesktopCloudTokenBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot();

  try {
    await invoke<void>("clear_cloud_device_token");
    return { status: "empty" };
  } catch (error) {
    return errorSnapshot(error);
  }
}

function getTauriInvoke(): TauriInvoke | undefined {
  return (globalThis as TauriGlobalScope).__TAURI__?.core?.invoke;
}

function unsupportedSnapshot(): DesktopCloudTokenBridgeSnapshot {
  return {
    status: "unsupported",
    lastError: "Tauri keychain bridge is not available in this browser session.",
  };
}

function errorSnapshot(error: unknown): DesktopCloudTokenBridgeSnapshot {
  return {
    status: "error",
    lastError: error instanceof Error ? error.message : String(error),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
