export interface DesktopCloudWorkspaceSetting {
  workspaceRef: string;
  displayName: string;
  rootLabel: string;
  capabilities: string[];
}

export interface DesktopCloudConnectionSettings {
  gatewayUrl: string;
  deviceId: string;
  desktopInstanceId?: string;
  deviceToken: string;
  workspaceCatalogText: string;
}

export interface DesktopCloudLifecyclePayload {
  url: string;
  authToken: string;
  deviceId: string;
  desktopInstanceId?: string;
  workspaceCatalog: {
    catalogVersion: string;
    workspaces: DesktopCloudWorkspaceSetting[];
  };
}

export type DesktopCloudConnectionReadiness = "missing_gateway" | "missing_token" | "missing_device" | "ready";

export const DEFAULT_CLOUD_GATEWAY_WS_URL = "wss://gateway.example.com/cloud/devices/ws";
export const CLOUD_CONNECTION_STORAGE_KEY = "xautojs.desktop.cloudConnection";

export function normalizeGatewayWsUrl(value: string): string {
  const trimmed = value.trim() || DEFAULT_CLOUD_GATEWAY_WS_URL;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed.replace(/\/+$/, "");
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`.replace(/\/+$/, "");
  return `wss://${trimmed}`.replace(/\/+$/, "");
}

export function cloudConnectionReadiness(settings: DesktopCloudConnectionSettings): DesktopCloudConnectionReadiness {
  if (!settings.gatewayUrl.trim()) return "missing_gateway";
  if (!settings.deviceToken.trim()) return "missing_token";
  if (!settings.deviceId.trim()) return "missing_device";
  return "ready";
}

export function buildDesktopCloudLifecyclePayload(
  settings: DesktopCloudConnectionSettings,
): DesktopCloudLifecyclePayload {
  return {
    url: normalizeGatewayWsUrl(settings.gatewayUrl),
    authToken: required(settings.deviceToken, "device token"),
    deviceId: required(settings.deviceId, "device id"),
    desktopInstanceId: optional(settings.desktopInstanceId),
    workspaceCatalog: {
      catalogVersion: `desktop-${Date.now()}`,
      workspaces: parseWorkspaceCatalogText(settings.workspaceCatalogText),
    },
  };
}

export function parseWorkspaceCatalogText(value: string): DesktopCloudWorkspaceSetting[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseWorkspaceCatalogLine)
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.workspaceRef.localeCompare(right.workspaceRef));
}

export function serializeWorkspaceCatalog(workspaces: DesktopCloudWorkspaceSetting[]): string {
  return workspaces
    .map((workspace) => [
      workspace.workspaceRef,
      workspace.displayName,
      workspace.rootLabel,
      workspace.capabilities.join(","),
    ].join(" | "))
    .join("\n");
}

export function readCloudConnectionSettings(storage: Storage = window.localStorage): DesktopCloudConnectionSettings {
  try {
    const raw = storage.getItem(CLOUD_CONNECTION_STORAGE_KEY);
    if (!raw) return defaultCloudConnectionSettings();
    const parsed = JSON.parse(raw) as Partial<DesktopCloudConnectionSettings>;
    return {
      gatewayUrl: typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : DEFAULT_CLOUD_GATEWAY_WS_URL,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      desktopInstanceId: typeof parsed.desktopInstanceId === "string" ? parsed.desktopInstanceId : "",
      deviceToken: "",
      workspaceCatalogText: typeof parsed.workspaceCatalogText === "string" ? parsed.workspaceCatalogText : "",
    };
  } catch {
    return defaultCloudConnectionSettings();
  }
}

export function storeCloudConnectionSettings(
  settings: DesktopCloudConnectionSettings,
  storage: Storage = window.localStorage,
): void {
  const persisted = {
    gatewayUrl: settings.gatewayUrl,
    deviceId: settings.deviceId,
    desktopInstanceId: settings.desktopInstanceId,
    workspaceCatalogText: settings.workspaceCatalogText,
  };
  storage.setItem(CLOUD_CONNECTION_STORAGE_KEY, JSON.stringify(persisted));
}

export function defaultCloudConnectionSettings(): DesktopCloudConnectionSettings {
  return {
    gatewayUrl: DEFAULT_CLOUD_GATEWAY_WS_URL,
    deviceId: "",
    desktopInstanceId: "",
    deviceToken: "",
    workspaceCatalogText: "",
  };
}

function parseWorkspaceCatalogLine(line: string): DesktopCloudWorkspaceSetting {
  const [workspaceRef, displayName, rootLabel, capabilities] = line.split("|").map((part) => part.trim());
  const ref = required(workspaceRef, "workspaceRef");
  return {
    workspaceRef: ref,
    displayName: displayName || ref,
    rootLabel: rootLabel || displayName || ref,
    capabilities: normalizeCapabilities(capabilities),
  };
}

function normalizeCapabilities(value: string | undefined): string[] {
  const capabilities = new Set(
    (value || "read")
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean),
  );
  return [...capabilities].sort();
}

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
