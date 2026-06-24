import {
  CloudRoutingError,
  type CloudSessionBindingRecord,
} from "./cloud-routing-contract.js";
import type { CloudDeviceConnectionRecord, CloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import type { CloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";

export interface ConnectDesktopInput {
  deviceId?: string;
}

export interface ConnectDesktopResult {
  status: "connected";
  conversationSessionId?: string;
  mcpSessionId: string;
  deviceId: string;
  connectionId?: string;
  capabilities: string[];
  expiresAt?: string;
}

export interface ListDevicesResult {
  devices: Array<{
    deviceId: string;
    connectionId: string;
    status: CloudDeviceConnectionRecord["status"];
    capabilities: string[];
    desktopInstanceId?: string;
    agentVersion?: string;
    connectedAt: string;
    lastHeartbeatAt: string;
    disconnectedAt?: string;
  }>;
}

export interface ListWorkspacesInput {
  deviceId?: string;
}

export interface ListWorkspacesResult {
  deviceId?: string;
  workspaces: Array<{
    workspaceRef: string;
    displayName: string;
    rootLabel: string;
    capabilities: string[];
    catalogVersion?: string;
    lastSeenAt: string;
  }>;
  catalogPending: boolean;
}

export class CloudDesktopToolService {
  constructor(
    private readonly sessionBindings: CloudSessionBindingService,
    private readonly deviceConnections: CloudDeviceConnectionStore,
    private readonly workspaceCatalog: CloudWorkspaceCatalogStore,
  ) {}

  async connectDesktop(
    context: DevspaceToolExecutionContext,
    input: ConnectDesktopInput = {},
  ): Promise<ConnectDesktopResult> {
    const requestedDeviceId = input.deviceId?.trim();
    if (!requestedDeviceId) {
      const existing = await this.resolveExistingBinding(context);
      if (existing) return this.connectedResult(context, existing);
    }

    const deviceId = requestedDeviceId || (await this.singleOnlineDeviceId(context));
    const binding = await this.sessionBindings.bindDevice({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId,
    });
    return this.connectedResult(context, binding);
  }

  async listDevices(context: DevspaceToolExecutionContext): Promise<ListDevicesResult> {
    const devices = await this.deviceConnections.listConnections({ owner: context.owner });
    return {
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        connectionId: device.connectionId,
        status: device.status,
        capabilities: [...device.capabilities],
        desktopInstanceId: device.desktopInstanceId,
        agentVersion: device.agentVersion,
        connectedAt: device.connectedAt,
        lastHeartbeatAt: device.lastHeartbeatAt,
        disconnectedAt: device.disconnectedAt,
      })),
    };
  }

  async listWorkspaces(
    context: DevspaceToolExecutionContext,
    input: ListWorkspacesInput = {},
  ): Promise<ListWorkspacesResult> {
    const requestedDeviceId = input.deviceId?.trim() || undefined;
    const binding = await this.sessionBindings.resolveDevice({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: requestedDeviceId,
    });
    const workspaces = await this.workspaceCatalog.listWorkspaces({
      owner: context.owner,
      deviceId: binding.deviceId,
    });

    return {
      deviceId: binding.deviceId,
      workspaces: workspaces.map((workspace) => ({
        workspaceRef: workspace.workspaceRef,
        displayName: workspace.displayName,
        rootLabel: workspace.rootLabel,
        capabilities: [...workspace.capabilities],
        catalogVersion: workspace.catalogVersion,
        lastSeenAt: workspace.lastSeenAt,
      })),
      catalogPending: workspaces.length === 0,
    };
  }

  private async resolveExistingBinding(
    context: DevspaceToolExecutionContext,
  ): Promise<CloudSessionBindingRecord | undefined> {
    try {
      return await this.sessionBindings.resolveDevice({
        owner: context.owner,
        mcpSessionId: context.mcpSessionId,
        conversationSessionId: context.conversationSessionId,
      });
    } catch (error) {
      if (error instanceof CloudRoutingError && error.code === "PAIRING_REQUIRED") return undefined;
      throw error;
    }
  }

  private async singleOnlineDeviceId(context: DevspaceToolExecutionContext): Promise<string> {
    const online = await this.deviceConnections.listConnections({ owner: context.owner, status: "online" });
    if (online.length === 1) return online[0]?.deviceId ?? "";

    throw new CloudRoutingError(
      "PAIRING_REQUIRED",
      online.length === 0
        ? "No online Desktop device is available for this MCP session."
        : "Multiple online Desktop devices are available; select a deviceId.",
      { details: { onlineDeviceCount: online.length } },
    );
  }

  private async connectedResult(
    context: DevspaceToolExecutionContext,
    binding: CloudSessionBindingRecord,
  ): Promise<ConnectDesktopResult> {
    const connection = await this.deviceConnections.getConnection(context.owner, binding.deviceId);
    return {
      status: "connected",
      conversationSessionId: binding.conversationSessionId,
      mcpSessionId: binding.mcpSessionId,
      deviceId: binding.deviceId,
      connectionId: connection?.connectionId,
      capabilities: connection?.capabilities ?? [],
      expiresAt: binding.expiresAt,
    };
  }
}
