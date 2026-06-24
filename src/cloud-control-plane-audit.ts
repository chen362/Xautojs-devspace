import { randomUUID } from "node:crypto";
import {
  CloudRoutingError,
  cloudRouteNow,
  cloudRoutingOwnerKey,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type { WorkspaceIdentity } from "./identity.js";

export type CloudControlPlaneAuditAction =
  | "device_code.create"
  | "device_code.approve"
  | "device_code.poll"
  | "connect_desktop"
  | "connect_workspace"
  | "route_tool_call";

export type CloudControlPlaneAuditStatus = "started" | "completed" | "failed" | "conflict";

export interface CloudControlPlaneAuditEvent<TResult = unknown> {
  eventId: string;
  owner?: WorkspaceIdentity;
  action: CloudControlPlaneAuditAction;
  status: CloudControlPlaneAuditStatus;
  idempotencyKey?: string;
  requestFingerprint?: string;
  result?: TResult;
  errorCode?: string;
  createdAt: string;
}

export interface RecordCloudControlPlaneAuditEventInput<TResult = unknown> {
  owner?: WorkspaceIdentity;
  action: CloudControlPlaneAuditAction;
  status: CloudControlPlaneAuditStatus;
  idempotencyKey?: string;
  requestFingerprint?: string;
  result?: TResult;
  errorCode?: string;
  now?: string;
}

export interface CloudControlPlaneIdempotencyRecord<TResult = unknown> {
  event: CloudControlPlaneAuditEvent<TResult>;
  replay: boolean;
}

export interface CloudControlPlaneAuditStore {
  recordEvent<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult>,
  ): Promise<CloudControlPlaneAuditEvent<TResult>>;
  findIdempotency<TResult = unknown>(
    owner: WorkspaceIdentity,
    action: CloudControlPlaneAuditAction,
    idempotencyKey: string,
  ): Promise<CloudControlPlaneIdempotencyRecord<TResult> | undefined>;
  recordIdempotency<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult> & {
      owner: WorkspaceIdentity;
      idempotencyKey: string;
      requestFingerprint: string;
      result: TResult;
    },
  ): Promise<CloudControlPlaneAuditEvent<TResult>>;
  listEvents?(owner?: WorkspaceIdentity): Promise<CloudControlPlaneAuditEvent[]>;
  close?(): Promise<void>;
}

export class InMemoryCloudControlPlaneAuditStore implements CloudControlPlaneAuditStore {
  private readonly events: CloudControlPlaneAuditEvent[] = [];
  private readonly idempotency = new Map<string, CloudControlPlaneAuditEvent>();

  async recordEvent<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult>,
  ): Promise<CloudControlPlaneAuditEvent<TResult>> {
    const event = normalizeAuditEvent(input);
    this.events.push(event);
    return cloneEvent(event);
  }

  async findIdempotency<TResult = unknown>(
    owner: WorkspaceIdentity,
    action: CloudControlPlaneAuditAction,
    idempotencyKey: string,
  ): Promise<CloudControlPlaneIdempotencyRecord<TResult> | undefined> {
    const event = this.idempotency.get(idempotencyMapKey(owner, action, idempotencyKey));
    return event ? { event: cloneEvent(event) as CloudControlPlaneAuditEvent<TResult>, replay: true } : undefined;
  }

  async recordIdempotency<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult> & {
      owner: WorkspaceIdentity;
      idempotencyKey: string;
      requestFingerprint: string;
      result: TResult;
    },
  ): Promise<CloudControlPlaneAuditEvent<TResult>> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const idempotencyKey = normalizeRequiredCloudRoutingId(input.idempotencyKey, "idempotencyKey");
    const key = idempotencyMapKey(owner, input.action, idempotencyKey);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new CloudRoutingError("TOOL_CALL_CONFLICT", "Idempotency key was already used with a different request.", {
          details: { action: input.action, idempotencyKey },
        });
      }
      return cloneEvent(existing) as CloudControlPlaneAuditEvent<TResult>;
    }

    const event = normalizeAuditEvent({
      ...input,
      owner,
      idempotencyKey,
      status: input.status ?? "completed",
    });
    this.events.push(event);
    this.idempotency.set(key, event);
    return cloneEvent(event);
  }

  async listEvents(ownerInput?: WorkspaceIdentity): Promise<CloudControlPlaneAuditEvent[]> {
    const ownerKey = ownerInput ? cloudRoutingOwnerKey(ownerInput) : undefined;
    return this.events
      .filter((event) => !ownerKey || (event.owner && cloudRoutingOwnerKey(event.owner) === ownerKey))
      .map(cloneEvent);
  }
}

export function stableControlPlaneFingerprint(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function normalizeAuditEvent<TResult>(
  input: RecordCloudControlPlaneAuditEventInput<TResult>,
): CloudControlPlaneAuditEvent<TResult> {
  const owner = input.owner ? normalizeCloudRouteOwner(input.owner) : undefined;
  return {
    eventId: `audit_${randomUUID()}`,
    owner,
    action: input.action,
    status: input.status,
    idempotencyKey: normalizeOptionalCloudRoutingId(input.idempotencyKey, "idempotencyKey"),
    requestFingerprint: normalizeOptionalCloudRoutingId(input.requestFingerprint, "requestFingerprint"),
    result: input.result,
    errorCode: normalizeOptionalCloudRoutingId(input.errorCode, "errorCode"),
    createdAt: cloudRouteNow(input.now),
  };
}

function idempotencyMapKey(owner: WorkspaceIdentity, action: CloudControlPlaneAuditAction, idempotencyKey: string): string {
  return `${cloudRoutingOwnerKey(owner)}\x1f${action}\x1f${normalizeRequiredCloudRoutingId(idempotencyKey, "idempotencyKey")}`;
}

function cloneEvent<TResult>(event: CloudControlPlaneAuditEvent<TResult>): CloudControlPlaneAuditEvent<TResult> {
  return {
    ...event,
    owner: event.owner ? { tenantId: event.owner.tenantId, userId: event.owner.userId } : undefined,
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
