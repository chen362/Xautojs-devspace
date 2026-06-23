import type { WorkspaceIdentity } from "./identity.js";
import {
  CloudRoutingError,
  cloudRoutingOwnerKey,
  normalizeCloudRouteCapabilities,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
  type BindCloudWorkspaceRouteInput,
  type CloudRoutingDeviceRecord,
  type CloudRoutingToolCallRecord,
  type CloudRoutingToolCallStatus,
  type CloudRoutingWorkspaceRouteRecord,
  type CompleteCloudToolCallRouteInput,
  type RegisterCloudRoutingDeviceInput,
  type ResolveCloudWorkspaceRouteInput,
  type ResolvedCloudWorkspaceRoute,
  type SetCloudRoutingDeviceStatusInput,
} from "./cloud-routing-contract.js";

export interface CloudRoutingStore {
  registerDevice(input: RegisterCloudRoutingDeviceInput): Promise<CloudRoutingDeviceRecord>;
  setDeviceStatus(input: SetCloudRoutingDeviceStatusInput): Promise<CloudRoutingDeviceRecord>;
  getDevice(owner: WorkspaceIdentity, deviceId: string): Promise<CloudRoutingDeviceRecord | undefined>;
  bindWorkspaceRoute(input: BindCloudWorkspaceRouteInput): Promise<CloudRoutingWorkspaceRouteRecord>;
  resolveWorkspaceRoute(input: ResolveCloudWorkspaceRouteInput): Promise<ResolvedCloudWorkspaceRoute>;
  getToolCallRoute(owner: WorkspaceIdentity, toolCallId: string): Promise<CloudRoutingToolCallRecord | undefined>;
  completeToolCallRoute(input: CompleteCloudToolCallRouteInput): Promise<CloudRoutingToolCallRecord | undefined>;
  close?(): Promise<void>;
}

export class InMemoryCloudRoutingStore implements CloudRoutingStore {
  private readonly devices = new Map<string, CloudRoutingDeviceRecord>();
  private readonly workspaceRoutes = new Map<string, CloudRoutingWorkspaceRouteRecord>();
  private readonly toolCallRoutes = new Map<string, CloudRoutingToolCallRecord>();

  async registerDevice(input: RegisterCloudRoutingDeviceInput): Promise<CloudRoutingDeviceRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const key = scopedKey(owner, deviceId);
    const now = routeNow(input.now);
    const existing = this.devices.get(key);
    const record: CloudRoutingDeviceRecord = {
      deviceId,
      owner,
      label: normalizeOptionalCloudRoutingId(input.label, "label"),
      capabilities: normalizeCloudRouteCapabilities(input.capabilities),
      status: input.status ?? "online",
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      expiresAt: normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt"),
    };

    this.devices.set(key, record);
    return cloneDevice(record);
  }

  async setDeviceStatus(input: SetCloudRoutingDeviceStatusInput): Promise<CloudRoutingDeviceRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const key = scopedKey(owner, deviceId);
    const existing = this.devices.get(key);
    if (!existing) {
      throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
        details: { deviceId },
      });
    }

    const updated: CloudRoutingDeviceRecord = {
      ...existing,
      status: input.status,
      lastSeenAt: routeNow(input.now),
    };
    this.devices.set(key, updated);
    return cloneDevice(updated);
  }

  async getDevice(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<CloudRoutingDeviceRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    const record = this.devices.get(scopedKey(owner, deviceId));
    return record ? cloneDevice(record) : undefined;
  }

  async bindWorkspaceRoute(input: BindCloudWorkspaceRouteInput): Promise<CloudRoutingWorkspaceRouteRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const workspaceId = normalizeRequiredCloudRoutingId(input.workspaceId, "workspaceId");
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const now = routeNow(input.now);

    const device = this.devices.get(scopedKey(owner, deviceId));
    this.assertDeviceRouteable(device, deviceId, now);

    const routeKey = scopedKey(owner, workspaceId);
    const existing = this.workspaceRoutes.get(routeKey);
    if (existing && !sameWorkspaceBinding(existing, { mcpSessionId, conversationSessionId, deviceId })) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "workspaceId is already bound to another MCP session, conversation, or device.",
        { details: { workspaceId, mcpSessionId } },
      );
    }

    const record: CloudRoutingWorkspaceRouteRecord = {
      workspaceId,
      owner,
      mcpSessionId,
      conversationSessionId,
      deviceId,
      workspaceRef: normalizeOptionalCloudRoutingId(input.workspaceRef, "workspaceRef"),
      status: "active",
      createdAt: existing?.createdAt ?? now,
      lastRoutedAt: existing?.lastRoutedAt,
      expiresAt: normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt"),
    };

    this.workspaceRoutes.set(routeKey, record);
    return cloneWorkspaceRoute(record);
  }

  async resolveWorkspaceRoute(input: ResolveCloudWorkspaceRouteInput): Promise<ResolvedCloudWorkspaceRoute> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const workspaceId = normalizeRequiredCloudRoutingId(input.workspaceId, "workspaceId");
    const now = routeNow(input.now);
    const routeKey = scopedKey(owner, workspaceId);
    const route = this.workspaceRoutes.get(routeKey);

    if (!route) {
      throw new CloudRoutingError("WORKSPACE_NOT_FOUND", "workspaceId is unknown for this owner.", {
        details: { workspaceId },
      });
    }

    this.assertWorkspaceRouteable(route, { mcpSessionId, conversationSessionId, now });

    const device = this.devices.get(scopedKey(owner, route.deviceId));
    this.assertDeviceRouteable(device, route.deviceId, now);

    const updatedRoute: CloudRoutingWorkspaceRouteRecord = { ...route, lastRoutedAt: now };
    this.workspaceRoutes.set(routeKey, updatedRoute);

    const toolCall = input.toolCallId
      ? this.recordToolCallRoute({
          owner,
          route: updatedRoute,
          toolCallId: input.toolCallId,
          tool: input.tool,
          now,
          deadlineAt: input.deadlineAt,
        })
      : undefined;

    return {
      workspace: cloneWorkspaceRoute(updatedRoute),
      device: cloneDevice(device),
      toolCall: toolCall ? cloneToolCallRoute(toolCall) : undefined,
      routedAt: now,
    };
  }

  async getToolCallRoute(
    ownerInput: WorkspaceIdentity,
    toolCallIdInput: string,
  ): Promise<CloudRoutingToolCallRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const toolCallId = normalizeRequiredCloudRoutingId(toolCallIdInput, "toolCallId");
    const record = this.toolCallRoutes.get(scopedKey(owner, toolCallId));
    return record ? cloneToolCallRoute(record) : undefined;
  }

  async completeToolCallRoute(input: CompleteCloudToolCallRouteInput): Promise<CloudRoutingToolCallRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const toolCallId = normalizeRequiredCloudRoutingId(input.toolCallId, "toolCallId");
    const key = scopedKey(owner, toolCallId);
    const existing = this.toolCallRoutes.get(key);
    if (!existing) return undefined;

    const now = routeNow(input.now);
    const updated: CloudRoutingToolCallRecord = {
      ...existing,
      status: input.status ?? "completed",
      lastSeenAt: now,
      completedAt: now,
    };
    this.toolCallRoutes.set(key, updated);
    return cloneToolCallRoute(updated);
  }

  private recordToolCallRoute(input: {
    owner: WorkspaceIdentity;
    route: CloudRoutingWorkspaceRouteRecord;
    toolCallId: string;
    tool?: ResolveCloudWorkspaceRouteInput["tool"];
    now: string;
    deadlineAt?: string;
  }): CloudRoutingToolCallRecord {
    const toolCallId = normalizeRequiredCloudRoutingId(input.toolCallId, "toolCallId");
    const key = scopedKey(input.owner, toolCallId);
    const deadlineAt = normalizeOptionalCloudRoutingId(input.deadlineAt, "deadlineAt");
    const existing = this.toolCallRoutes.get(key);
    const nextRoute = {
      mcpSessionId: input.route.mcpSessionId,
      conversationSessionId: input.route.conversationSessionId,
      workspaceId: input.route.workspaceId,
      deviceId: input.route.deviceId,
      tool: input.tool,
    };

    if (existing) {
      if (!sameToolCallRoute(existing, nextRoute)) {
        throw new CloudRoutingError(
          "TOOL_CALL_CONFLICT",
          "toolCallId has already been routed to a different workspace, device, or tool.",
          { details: { toolCallId } },
        );
      }

      const updated: CloudRoutingToolCallRecord = { ...existing, lastSeenAt: input.now };
      this.toolCallRoutes.set(key, updated);
      return updated;
    }

    const record: CloudRoutingToolCallRecord = {
      toolCallId,
      owner: cloneOwner(input.owner),
      mcpSessionId: input.route.mcpSessionId,
      conversationSessionId: input.route.conversationSessionId,
      workspaceId: input.route.workspaceId,
      deviceId: input.route.deviceId,
      tool: input.tool,
      status: "routed",
      createdAt: input.now,
      lastSeenAt: input.now,
      deadlineAt,
    };
    this.toolCallRoutes.set(key, record);
    return record;
  }

  private assertWorkspaceRouteable(
    route: CloudRoutingWorkspaceRouteRecord,
    input: { mcpSessionId: string; conversationSessionId?: string; now: string },
  ): void {
    if (route.mcpSessionId !== input.mcpSessionId) {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "workspaceId belongs to another MCP session.", {
        details: { workspaceId: route.workspaceId, mcpSessionId: input.mcpSessionId },
      });
    }

    if (route.conversationSessionId && route.conversationSessionId !== input.conversationSessionId) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "workspaceId belongs to another conversation session.",
        { details: { workspaceId: route.workspaceId } },
      );
    }

    if (route.status === "revoked") {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "workspace route is revoked.", {
        details: { workspaceId: route.workspaceId },
      });
    }

    if (route.status === "expired" || isExpired(route.expiresAt, input.now)) {
      throw new CloudRoutingError("SESSION_EXPIRED", "workspace route is expired.", {
        details: { workspaceId: route.workspaceId },
      });
    }
  }

  private assertDeviceRouteable(
    device: CloudRoutingDeviceRecord | undefined,
    deviceId: string,
    now: string,
  ): asserts device is CloudRoutingDeviceRecord {
    if (!device || device.status === "revoked") {
      throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
        details: { deviceId },
      });
    }

    if (isExpired(device.expiresAt, now)) {
      throw new CloudRoutingError("SESSION_EXPIRED", "Device route is expired.", {
        details: { deviceId },
      });
    }

    if (device.status !== "online") {
      throw new CloudRoutingError("DEVICE_OFFLINE", "Device is offline.", {
        retryable: true,
        details: { deviceId },
      });
    }
  }
}

function scopedKey(owner: WorkspaceIdentity, id: string): string {
  return `${cloudRoutingOwnerKey(owner)}\x1f${id}`;
}

function routeNow(now: string | undefined): string {
  return normalizeOptionalCloudRoutingId(now, "now") ?? new Date().toISOString();
}

function sameWorkspaceBinding(
  existing: CloudRoutingWorkspaceRouteRecord,
  next: { mcpSessionId: string; conversationSessionId?: string; deviceId: string },
): boolean {
  return (
    existing.mcpSessionId === next.mcpSessionId &&
    existing.conversationSessionId === next.conversationSessionId &&
    existing.deviceId === next.deviceId
  );
}

function sameToolCallRoute(
  existing: CloudRoutingToolCallRecord,
  next: {
    mcpSessionId: string;
    conversationSessionId?: string;
    workspaceId: string;
    deviceId: string;
    tool?: ResolveCloudWorkspaceRouteInput["tool"];
  },
): boolean {
  return (
    existing.mcpSessionId === next.mcpSessionId &&
    existing.conversationSessionId === next.conversationSessionId &&
    existing.workspaceId === next.workspaceId &&
    existing.deviceId === next.deviceId &&
    existing.tool === next.tool
  );
}

function isExpired(expiresAt: string | undefined, now: string): boolean {
  if (!expiresAt) return false;
  const expiresTime = Date.parse(expiresAt);
  const nowTime = Date.parse(now);
  if (Number.isNaN(expiresTime) || Number.isNaN(nowTime)) return expiresAt <= now;
  return expiresTime <= nowTime;
}

function cloneDevice(record: CloudRoutingDeviceRecord): CloudRoutingDeviceRecord {
  return {
    ...record,
    owner: cloneOwner(record.owner),
    capabilities: [...record.capabilities],
  };
}

function cloneWorkspaceRoute(record: CloudRoutingWorkspaceRouteRecord): CloudRoutingWorkspaceRouteRecord {
  return {
    ...record,
    owner: cloneOwner(record.owner),
  };
}

function cloneToolCallRoute(record: CloudRoutingToolCallRecord): CloudRoutingToolCallRecord {
  return {
    ...record,
    owner: cloneOwner(record.owner),
  };
}

function cloneOwner(owner: WorkspaceIdentity): WorkspaceIdentity {
  return {
    tenantId: owner.tenantId,
    userId: owner.userId,
  };
}
