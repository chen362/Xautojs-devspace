import {
  cloudRoutingOwnerKey,
  normalizeCloudRouteCapabilities,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type { WorkspaceIdentity } from "./identity.js";

export type CloudDeviceConnectionStatus = "online" | "offline";

export interface CloudDeviceConnectionRecord {
  owner: WorkspaceIdentity;
  deviceId: string;
  connectionId: string;
  status: CloudDeviceConnectionStatus;
  capabilities: string[];
  desktopInstanceId?: string;
  agentVersion?: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  disconnectedAt?: string;
}

export interface RecordCloudDeviceConnectedInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  connectionId: string;
  capabilities?: readonly string[];
  desktopInstanceId?: string;
  agentVersion?: string;
  now?: string;
}

export interface RecordCloudDeviceHeartbeatInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  connectionId: string;
  now?: string;
}

export interface RecordCloudDeviceDisconnectedInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  connectionId: string;
  now?: string;
}

export interface ListCloudDeviceConnectionsInput {
  owner: WorkspaceIdentity;
  status?: CloudDeviceConnectionStatus;
}

export interface CloudDeviceConnectionStore {
  recordConnected(input: RecordCloudDeviceConnectedInput): Promise<CloudDeviceConnectionRecord>;
  recordHeartbeat(input: RecordCloudDeviceHeartbeatInput): Promise<CloudDeviceConnectionRecord | undefined>;
  recordDisconnected(input: RecordCloudDeviceDisconnectedInput): Promise<CloudDeviceConnectionRecord | undefined>;
  getConnection(owner: WorkspaceIdentity, deviceId: string): Promise<CloudDeviceConnectionRecord | undefined>;
  listConnections(input: ListCloudDeviceConnectionsInput): Promise<CloudDeviceConnectionRecord[]>;
  close?(): Promise<void>;
}

export class InMemoryCloudDeviceConnectionStore implements CloudDeviceConnectionStore {
  private readonly connections = new Map<string, CloudDeviceConnectionRecord>();

  async recordConnected(input: RecordCloudDeviceConnectedInput): Promise<CloudDeviceConnectionRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const now = routeNow(input.now);
    const existing = this.connections.get(scopedKey(owner, deviceId));
    const record: CloudDeviceConnectionRecord = {
      owner,
      deviceId,
      connectionId,
      status: "online",
      capabilities: normalizeCloudRouteCapabilities(input.capabilities),
      desktopInstanceId: normalizeOptionalCloudRoutingId(input.desktopInstanceId, "desktopInstanceId"),
      agentVersion: normalizeOptionalCloudRoutingId(input.agentVersion, "agentVersion"),
      connectedAt: existing?.connectedAt ?? now,
      lastHeartbeatAt: now,
      disconnectedAt: undefined,
    };
    this.connections.set(scopedKey(owner, deviceId), record);
    return cloneConnection(record);
  }

  async recordHeartbeat(input: RecordCloudDeviceHeartbeatInput): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const key = scopedKey(owner, deviceId);
    const existing = this.connections.get(key);
    if (!existing || existing.connectionId !== connectionId) return undefined;

    const updated: CloudDeviceConnectionRecord = {
      ...existing,
      status: "online",
      lastHeartbeatAt: routeNow(input.now),
      disconnectedAt: undefined,
    };
    this.connections.set(key, updated);
    return cloneConnection(updated);
  }

  async recordDisconnected(input: RecordCloudDeviceDisconnectedInput): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const key = scopedKey(owner, deviceId);
    const existing = this.connections.get(key);
    if (!existing || existing.connectionId !== connectionId) return undefined;

    const now = routeNow(input.now);
    const updated: CloudDeviceConnectionRecord = {
      ...existing,
      status: "offline",
      lastHeartbeatAt: now,
      disconnectedAt: now,
    };
    this.connections.set(key, updated);
    return cloneConnection(updated);
  }

  async getConnection(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    const record = this.connections.get(scopedKey(owner, deviceId));
    return record ? cloneConnection(record) : undefined;
  }

  async listConnections(input: ListCloudDeviceConnectionsInput): Promise<CloudDeviceConnectionRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    return [...this.connections.values()]
      .filter((connection) =>
        cloudRoutingOwnerKey(connection.owner) === cloudRoutingOwnerKey(owner) &&
        (!input.status || connection.status === input.status),
      )
      .sort((left, right) => right.lastHeartbeatAt.localeCompare(left.lastHeartbeatAt))
      .map(cloneConnection);
  }
}

function scopedKey(owner: WorkspaceIdentity, deviceId: string): string {
  return `${cloudRoutingOwnerKey(owner)}\x1f${deviceId}`;
}

function routeNow(now: string | undefined): string {
  return normalizeOptionalCloudRoutingId(now, "now") ?? new Date().toISOString();
}

function cloneConnection(record: CloudDeviceConnectionRecord): CloudDeviceConnectionRecord {
  return {
    ...record,
    owner: { tenantId: record.owner.tenantId, userId: record.owner.userId },
    capabilities: [...record.capabilities],
  };
}
