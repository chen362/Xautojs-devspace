import {
  CloudRoutingError,
  cloudRouteNow,
  cloudRoutingOwnerKey,
  isCloudRouteExpired,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
  type BindCloudSessionToDeviceInput,
  type CloudSessionBindingRecord,
  type ResolveCloudSessionDeviceInput,
} from "./cloud-routing-contract.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import type { WorkspaceIdentity } from "./identity.js";

export interface CloudSessionBindingService {
  bindDevice(input: BindCloudSessionToDeviceInput): Promise<CloudSessionBindingRecord>;
  resolveDevice(input: ResolveCloudSessionDeviceInput): Promise<CloudSessionBindingRecord>;
}

export class InMemoryCloudSessionBindingService implements CloudSessionBindingService {
  private readonly bindings = new Map<string, CloudSessionBindingRecord>();

  constructor(private readonly routingStore: CloudRoutingStore) {}

  async bindDevice(input: BindCloudSessionToDeviceInput): Promise<CloudSessionBindingRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    const expiresAt = normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt");
    const device = await this.routingStore.getDevice(owner, deviceId);

    if (!device || device.status === "revoked") {
      throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
        details: { deviceId },
      });
    }
    if (isCloudRouteExpired(device.expiresAt, now)) {
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

    const key = bindingKey(owner, mcpSessionId);
    const existing = this.bindings.get(key);
    if (existing && !sameBinding(existing, { conversationSessionId, deviceId })) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "MCP session is already paired with another conversation or device.",
        { details: { mcpSessionId } },
      );
    }

    const binding: CloudSessionBindingRecord = {
      owner,
      mcpSessionId,
      conversationSessionId,
      deviceId,
      boundAt: existing?.boundAt ?? now,
      lastSeenAt: now,
      expiresAt,
    };
    this.bindings.set(key, binding);
    return cloneBinding(binding);
  }

  async resolveDevice(input: ResolveCloudSessionDeviceInput): Promise<CloudSessionBindingRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const requestedDeviceId = normalizeOptionalCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    const key = bindingKey(owner, mcpSessionId);
    const existing = this.bindings.get(key);

    if (!existing) {
      if (!requestedDeviceId) {
        throw new CloudRoutingError("PAIRING_REQUIRED", "MCP session is not paired with a Desktop device.", {
          details: { mcpSessionId },
        });
      }

      return this.bindDevice({
        owner,
        mcpSessionId,
        conversationSessionId,
        deviceId: requestedDeviceId,
        now,
      });
    }

    if (existing.conversationSessionId && existing.conversationSessionId !== conversationSessionId) {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "MCP session is paired with another conversation.", {
        details: { mcpSessionId },
      });
    }
    if (requestedDeviceId && existing.deviceId !== requestedDeviceId) {
      throw new CloudRoutingError("DEVICE_FORBIDDEN", "MCP session is paired with another device.", {
        details: { deviceId: requestedDeviceId },
      });
    }
    if (isCloudRouteExpired(existing.expiresAt, now)) {
      this.bindings.delete(key);
      throw new CloudRoutingError("SESSION_EXPIRED", "MCP session device pairing is expired.", {
        details: { mcpSessionId },
      });
    }

    const device = await this.routingStore.getDevice(owner, existing.deviceId);
    if (!device || device.status === "revoked") {
      throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
        details: { deviceId: existing.deviceId },
      });
    }
    if (device.status !== "online") {
      throw new CloudRoutingError("DEVICE_OFFLINE", "Device is offline.", {
        retryable: true,
        details: { deviceId: existing.deviceId },
      });
    }

    const updated: CloudSessionBindingRecord = { ...existing, lastSeenAt: now };
    this.bindings.set(key, updated);
    return cloneBinding(updated);
  }
}

function bindingKey(owner: WorkspaceIdentity, mcpSessionId: string): string {
  return `${cloudRoutingOwnerKey(owner)}\x1f${mcpSessionId}`;
}

function sameBinding(
  existing: CloudSessionBindingRecord,
  next: { conversationSessionId?: string; deviceId: string },
): boolean {
  return existing.conversationSessionId === next.conversationSessionId && existing.deviceId === next.deviceId;
}

function cloneBinding(binding: CloudSessionBindingRecord): CloudSessionBindingRecord {
  return {
    ...binding,
    owner: {
      tenantId: binding.owner.tenantId,
      userId: binding.owner.userId,
    },
  };
}
