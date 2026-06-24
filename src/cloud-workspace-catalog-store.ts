import {
  cloudRouteNow,
  cloudRoutingOwnerKey,
  normalizeCloudRouteCapabilities,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type { CloudWorkspaceCatalogEntry } from "./cloud-device-channel-protocol.js";
import type { WorkspaceIdentity } from "./identity.js";

export interface CloudWorkspaceCatalogRecord extends CloudWorkspaceCatalogEntry {
  owner: WorkspaceIdentity;
  deviceId: string;
  catalogVersion?: string;
  lastSeenAt: string;
}

export interface RecordCloudWorkspaceCatalogInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  catalogVersion?: string;
  workspaces: CloudWorkspaceCatalogEntry[];
  now?: string;
}

export interface ListCloudWorkspaceCatalogInput {
  owner: WorkspaceIdentity;
  deviceId: string;
}

export interface CloudWorkspaceCatalogStore {
  recordCatalog(input: RecordCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]>;
  listWorkspaces(input: ListCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]>;
  clearDeviceCatalog?(owner: WorkspaceIdentity, deviceId: string): Promise<void>;
  close?(): Promise<void>;
}

export class InMemoryCloudWorkspaceCatalogStore implements CloudWorkspaceCatalogStore {
  private readonly records = new Map<string, CloudWorkspaceCatalogRecord>();

  async recordCatalog(input: RecordCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const catalogVersion = normalizeOptionalCloudRoutingId(input.catalogVersion, "catalogVersion");
    const lastSeenAt = cloudRouteNow(input.now);
    const normalized = input.workspaces.map((workspace) => normalizeWorkspaceCatalogEntry(workspace, {
      owner,
      deviceId,
      catalogVersion,
      lastSeenAt,
    }));
    const prefix = catalogKeyPrefix(owner, deviceId);

    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
    for (const record of normalized) this.records.set(catalogKey(owner, deviceId, record.workspaceRef), record);

    return normalized.map(cloneRecord);
  }

  async listWorkspaces(input: ListCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const prefix = catalogKeyPrefix(owner, deviceId);

    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => cloneRecord(record))
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.workspaceRef.localeCompare(right.workspaceRef));
  }

  async clearDeviceCatalog(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<void> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    const prefix = catalogKeyPrefix(owner, deviceId);
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) this.records.delete(key);
    }
  }
}

export function normalizeWorkspaceCatalogEntry(
  input: CloudWorkspaceCatalogEntry,
  context: {
    owner: WorkspaceIdentity;
    deviceId: string;
    catalogVersion?: string;
    lastSeenAt: string;
  },
): CloudWorkspaceCatalogRecord {
  const workspaceRef = normalizeRequiredCloudRoutingId(input.workspaceRef, "workspaceRef");
  const displayName = normalizeDisplayText(input.displayName, workspaceRef);
  const rootLabel = normalizeDisplayText(input.rootLabel, displayName);

  return {
    owner: {
      tenantId: context.owner.tenantId,
      userId: context.owner.userId,
    },
    deviceId: context.deviceId,
    workspaceRef,
    displayName,
    rootLabel,
    capabilities: normalizeCloudRouteCapabilities(input.capabilities),
    catalogVersion: context.catalogVersion,
    lastSeenAt: context.lastSeenAt,
  };
}

function normalizeDisplayText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : fallback;
}

function catalogKeyPrefix(owner: WorkspaceIdentity, deviceId: string): string {
  return `${cloudRoutingOwnerKey(owner)}\x1f${deviceId}\x1f`;
}

function catalogKey(owner: WorkspaceIdentity, deviceId: string, workspaceRef: string): string {
  return `${catalogKeyPrefix(owner, deviceId)}${workspaceRef}`;
}

function cloneRecord(record: CloudWorkspaceCatalogRecord): CloudWorkspaceCatalogRecord {
  return {
    ...record,
    owner: {
      tenantId: record.owner.tenantId,
      userId: record.owner.userId,
    },
    capabilities: [...record.capabilities],
  };
}
