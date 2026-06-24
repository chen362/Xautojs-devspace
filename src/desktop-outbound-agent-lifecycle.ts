import { LocalAgentOutboundClient } from "./local-agent-outbound-client.js";
import type { LocalAgentToolReceiver } from "./local-agent-receiver.js";
import type {
  LocalAgentSocketFactory,
  LocalAgentWorkspaceCatalogProvider,
} from "./local-agent-outbound-client.js";

export type DesktopOutboundAgentStatus = "stopped" | "running";

export interface DesktopOutboundAgentConfig {
  url: string;
  authToken: string;
  deviceId: string;
  receiver: LocalAgentToolReceiver;
  capabilities?: readonly string[];
  desktopInstanceId?: string;
  agentVersion?: string;
  workspaceCatalogProvider?: LocalAgentWorkspaceCatalogProvider;
  heartbeatIntervalMs?: number;
  workspaceCatalogIntervalMs?: number;
  headers?: Record<string, string>;
  socketFactory?: LocalAgentSocketFactory;
  now?: () => string;
}

export interface DesktopOutboundAgentSnapshot {
  status: DesktopOutboundAgentStatus;
  url?: string;
  deviceId?: string;
  desktopInstanceId?: string;
  agentVersion?: string;
  startedAt?: string;
  stoppedAt?: string;
}

export class DesktopOutboundAgentLifecycle {
  private client: LocalAgentOutboundClient | undefined;
  private config: DesktopOutboundAgentConfig | undefined;
  private snapshot: DesktopOutboundAgentSnapshot = { status: "stopped" };

  start(config: DesktopOutboundAgentConfig): DesktopOutboundAgentSnapshot {
    this.stop("restarting");
    const normalized = normalizeConfig(config);
    const client = new LocalAgentOutboundClient({
      url: normalized.url,
      deviceId: normalized.deviceId,
      receiver: normalized.receiver,
      capabilities: normalized.capabilities,
      desktopInstanceId: normalized.desktopInstanceId,
      agentVersion: normalized.agentVersion,
      headers: {
        ...normalized.headers,
        authorization: `Bearer ${normalized.authToken}`,
      },
      heartbeatIntervalMs: normalized.heartbeatIntervalMs,
      workspaceCatalogProvider: normalized.workspaceCatalogProvider,
      workspaceCatalogIntervalMs: normalized.workspaceCatalogIntervalMs,
      socketFactory: normalized.socketFactory,
      now: normalized.now,
    });

    this.client = client;
    this.config = normalized;
    this.snapshot = {
      status: "running",
      url: normalized.url,
      deviceId: normalized.deviceId,
      desktopInstanceId: normalized.desktopInstanceId,
      agentVersion: normalized.agentVersion,
      startedAt: normalized.now?.() ?? new Date().toISOString(),
    };
    client.start();
    return this.current();
  }

  restart(): DesktopOutboundAgentSnapshot {
    if (!this.config) return this.current();
    return this.start(this.config);
  }

  stop(reason = "desktop_stopped"): DesktopOutboundAgentSnapshot {
    const stoppedAt = this.config?.now?.() ?? new Date().toISOString();
    this.client?.stop(reason);
    this.client = undefined;
    this.snapshot = {
      ...this.snapshot,
      status: "stopped",
      stoppedAt,
    };
    return this.current();
  }

  publishWorkspaceCatalog(): Promise<void> {
    return this.client?.publishWorkspaceCatalog() ?? Promise.resolve();
  }

  current(): DesktopOutboundAgentSnapshot {
    return { ...this.snapshot };
  }
}

function normalizeConfig(config: DesktopOutboundAgentConfig): DesktopOutboundAgentConfig {
  return {
    ...config,
    url: requiredString(config.url, "url"),
    authToken: requiredString(config.authToken, "authToken"),
    deviceId: requiredString(config.deviceId, "deviceId"),
    capabilities: config.capabilities ? [...config.capabilities] : undefined,
    headers: normalizeHeaders(config.headers),
  };
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const trimmedKey = key.trim().toLowerCase();
    const trimmedValue = value.trim();
    if (trimmedKey && trimmedValue && trimmedKey !== "authorization") normalized[trimmedKey] = trimmedValue;
  }
  return normalized;
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required for Desktop outbound agent lifecycle.`);
  return trimmed;
}
