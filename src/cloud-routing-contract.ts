import type { WorkspaceIdentity } from "./identity.js";
import type { RemoteMcpToolName } from "./remote-mcp-tool-executor.js";

export type CloudRoutingDeviceStatus = "online" | "offline" | "revoked";
export type CloudRoutingWorkspaceStatus = "active" | "expired" | "revoked";
export type CloudRoutingToolCallStatus = "routed" | "completed" | "failed" | "cancelled";

export type CloudRoutingErrorCode =
  | "INVALID_ROUTE_INPUT"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_OFFLINE"
  | "DEVICE_FORBIDDEN"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_FORBIDDEN"
  | "SESSION_EXPIRED"
  | "TOOL_CALL_CONFLICT";

export interface CloudRoutingErrorOptions {
  retryable?: boolean;
  details?: unknown;
}

export class CloudRoutingError extends Error {
  readonly code: CloudRoutingErrorCode;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: CloudRoutingErrorCode, message: string, options: CloudRoutingErrorOptions = {}) {
    super(message);
    this.name = "CloudRoutingError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export interface CloudRoutingDeviceRecord {
  deviceId: string;
  owner: WorkspaceIdentity;
  label?: string;
  capabilities: string[];
  status: CloudRoutingDeviceStatus;
  registeredAt: string;
  lastSeenAt: string;
  expiresAt?: string;
}

export interface CloudRoutingWorkspaceRouteRecord {
  workspaceId: string;
  owner: WorkspaceIdentity;
  mcpSessionId: string;
  conversationSessionId?: string;
  deviceId: string;
  workspaceRef?: string;
  status: CloudRoutingWorkspaceStatus;
  createdAt: string;
  lastRoutedAt?: string;
  expiresAt?: string;
}

export interface CloudRoutingToolCallRecord {
  toolCallId: string;
  owner: WorkspaceIdentity;
  mcpSessionId: string;
  conversationSessionId?: string;
  workspaceId: string;
  deviceId: string;
  tool?: RemoteMcpToolName;
  status: CloudRoutingToolCallStatus;
  createdAt: string;
  lastSeenAt: string;
  deadlineAt?: string;
  completedAt?: string;
}

export interface ResolvedCloudWorkspaceRoute {
  workspace: CloudRoutingWorkspaceRouteRecord;
  device: CloudRoutingDeviceRecord;
  toolCall?: CloudRoutingToolCallRecord;
  routedAt: string;
}

export interface RegisterCloudRoutingDeviceInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  label?: string;
  capabilities?: readonly string[];
  status?: CloudRoutingDeviceStatus;
  now?: string;
  expiresAt?: string;
}

export interface SetCloudRoutingDeviceStatusInput {
  owner: WorkspaceIdentity;
  deviceId: string;
  status: CloudRoutingDeviceStatus;
  now?: string;
}

export interface BindCloudWorkspaceRouteInput {
  owner: WorkspaceIdentity;
  mcpSessionId: string;
  conversationSessionId?: string;
  workspaceId: string;
  deviceId: string;
  workspaceRef?: string;
  now?: string;
  expiresAt?: string;
}

export interface ResolveCloudWorkspaceRouteInput {
  owner: WorkspaceIdentity;
  mcpSessionId: string;
  conversationSessionId?: string;
  workspaceId: string;
  toolCallId?: string;
  tool?: RemoteMcpToolName;
  now?: string;
  deadlineAt?: string;
}

export interface CompleteCloudToolCallRouteInput {
  owner: WorkspaceIdentity;
  toolCallId: string;
  status?: Exclude<CloudRoutingToolCallStatus, "routed">;
  now?: string;
}

export function normalizeCloudRouteOwner(owner: WorkspaceIdentity): WorkspaceIdentity {
  return {
    tenantId: normalizeRequiredCloudRoutingId(owner.tenantId, "owner.tenantId"),
    userId: normalizeRequiredCloudRoutingId(owner.userId, "owner.userId"),
  };
}

export function cloudRoutingOwnerKey(owner: WorkspaceIdentity): string {
  const normalized = normalizeCloudRouteOwner(owner);
  return `${normalized.tenantId}\x1f${normalized.userId}`;
}

export function normalizeRequiredCloudRoutingId(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new CloudRoutingError("INVALID_ROUTE_INPUT", `${name} is required.`, {
      details: { field: name },
    });
  }
  return normalized;
}

export function normalizeOptionalCloudRoutingId(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) {
    throw new CloudRoutingError("INVALID_ROUTE_INPUT", `${name} cannot be empty.`, {
      details: { field: name },
    });
  }
  return normalized;
}

export function normalizeCloudRouteCapabilities(capabilities: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const capability of capabilities ?? []) {
    const value = normalizeOptionalCloudRoutingId(capability, "capability");
    if (value) normalized.add(value);
  }
  return [...normalized].sort();
}
