import type { DesktopCloudLifecyclePayload } from "./cloud-connection-client.js";

export type DesktopCloudLifecycleBridgeStatus = "unsupported" | "stopped" | "running" | "error";

export interface DesktopCloudLifecycleBridgeSnapshot {
  status: DesktopCloudLifecycleBridgeStatus;
  deviceId?: string;
  desktopInstanceId?: string;
  url?: string;
  workspaceCount: number;
  processId?: number;
  startedAt?: string;
  stoppedAt?: string;
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

export async function startDesktopCloudLifecycle(
  payload: DesktopCloudLifecyclePayload,
): Promise<DesktopCloudLifecycleBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot(payload.workspaceCatalog.workspaces.length);

  try {
    await invoke<void>("store_cloud_device_token", { token: payload.authToken });
    return normalizeSnapshot(await invoke<DesktopCloudLifecycleBridgeSnapshot>("start_cloud_lifecycle", { payload }));
  } catch (error) {
    return errorSnapshot(payload.workspaceCatalog.workspaces.length, error);
  }
}

export async function stopDesktopCloudLifecycle(): Promise<DesktopCloudLifecycleBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot(0);

  try {
    return normalizeSnapshot(await invoke<DesktopCloudLifecycleBridgeSnapshot>("stop_cloud_lifecycle"));
  } catch (error) {
    return errorSnapshot(0, error);
  }
}

export async function getDesktopCloudLifecycle(): Promise<DesktopCloudLifecycleBridgeSnapshot> {
  const invoke = getTauriInvoke();
  if (!invoke) return unsupportedSnapshot(0);

  try {
    return normalizeSnapshot(await invoke<DesktopCloudLifecycleBridgeSnapshot>("get_cloud_lifecycle"));
  } catch (error) {
    return errorSnapshot(0, error);
  }
}

function getTauriInvoke(): TauriInvoke | undefined {
  return (globalThis as TauriGlobalScope).__TAURI__?.core?.invoke;
}

function normalizeSnapshot(value: DesktopCloudLifecycleBridgeSnapshot): DesktopCloudLifecycleBridgeSnapshot {
  return {
    status: normalizeStatus(value.status),
    deviceId: optionalString(value.deviceId),
    desktopInstanceId: optionalString(value.desktopInstanceId),
    url: optionalString(value.url),
    workspaceCount: typeof value.workspaceCount === "number" ? value.workspaceCount : 0,
    processId: typeof value.processId === "number" ? value.processId : undefined,
    startedAt: optionalString(value.startedAt),
    stoppedAt: optionalString(value.stoppedAt),
    lastError: optionalString(value.lastError),
  };
}

function normalizeStatus(status: string): DesktopCloudLifecycleBridgeStatus {
  if (status === "stopped" || status === "running" || status === "error" || status === "unsupported") return status;
  return "error";
}

function unsupportedSnapshot(workspaceCount: number): DesktopCloudLifecycleBridgeSnapshot {
  return {
    status: "unsupported",
    workspaceCount,
    lastError: "Tauri lifecycle bridge is not available in this browser session.",
  };
}

function errorSnapshot(workspaceCount: number, error: unknown): DesktopCloudLifecycleBridgeSnapshot {
  return {
    status: "error",
    workspaceCount,
    lastError: error instanceof Error ? error.message : String(error),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
