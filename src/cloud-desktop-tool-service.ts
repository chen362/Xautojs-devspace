import {
  CloudRoutingError,
  type CloudSessionBindingRecord,
} from "./cloud-routing-contract.js";
import type { CloudDeviceConnectionRecord, CloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
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
  }>;
  catalogPending: boolean;
}

export class CloudDesktopToolService {
  constructor(
    private readonly sessionBindings: CloudSessionBindingService,
    private readonly deviceConnections: CloudDeviceConnectionStore,
  ) {}

  async connectDesktop(
    context: DevspaceToolExecutionContext,
    input: ConnectDesktopInput = {},
  ): Promise<ConnectDesktopResult> {
    const deviceId = input.deviceId?.trim() || await this.singleOnlineDeviceId(context);
    const binding = await this.sessionBindings.resolveDevice({
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
    const deviceId = input.deviceId?.trim() || (await this.sessionBindings.resolveDevice({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
    })).deviceId;

    return {
      deviceId,
      workspaces: [],
      catalogPending: true,
    };
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
