import { createHash } from "node:crypto";
import {
  CloudRoutingError,
  type CloudRoutingWorkspaceRouteRecord,
} from "./cloud-routing-contract.js";
import type { CloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import { stableControlPlaneFingerprint } from "./cloud-control-plane-audit.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import type { CloudWorkspaceCatalogRecord, CloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";

export interface ConnectCloudWorkspaceInput {
  workspaceRef: string;
  deviceId?: string;
  workspaceId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}

export interface ConnectCloudWorkspaceResult {
  status: "connected";
  workspaceId: string;
  workspaceRef: string;
  deviceId: string;
  displayName: string;
  rootLabel: string;
  capabilities: string[];
  route: CloudRoutingWorkspaceRouteRecord;
  idempotencyKey?: string;
  idempotentReplay?: boolean;
}

export class CloudWorkspaceSelectionService {
  constructor(
    private readonly sessionBindings: CloudSessionBindingService,
    private readonly routingStore: CloudRoutingStore,
    private readonly workspaceCatalog: CloudWorkspaceCatalogStore,
    private readonly auditStore?: CloudControlPlaneAuditStore,
  ) {}

  async connectWorkspace(
    context: DevspaceToolExecutionContext,
    input: ConnectCloudWorkspaceInput,
  ): Promise<ConnectCloudWorkspaceResult> {
    const binding = await this.sessionBindings.resolveDevice({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: input.deviceId,
    });
    const catalogEntry = await this.requireCatalogEntry(context, binding.deviceId, input.workspaceRef);
    const workspaceId = input.workspaceId?.trim() || deterministicWorkspaceId({
      tenantId: context.owner.tenantId,
      userId: context.owner.userId,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: binding.deviceId,
      workspaceRef: catalogEntry.workspaceRef,
    });
    const fingerprint = stableControlPlaneFingerprint({
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      deviceId: binding.deviceId,
      workspaceId,
      workspaceRef: catalogEntry.workspaceRef,
    });

    if (input.idempotencyKey) {
      const replay = await this.auditStore?.findIdempotency<ConnectCloudWorkspaceResult>(
        context.owner,
        "connect_workspace",
        input.idempotencyKey,
      );
      if (replay) {
        if (replay.event.requestFingerprint !== fingerprint) {
          throw new CloudRoutingError("TOOL_CALL_CONFLICT", "Idempotency key was already used with a different workspace selection.", {
            details: { idempotencyKey: input.idempotencyKey },
          });
        }
        return { ...replay.event.result, idempotentReplay: true } as ConnectCloudWorkspaceResult;
      }
    }

    const route = await this.routingStore.bindWorkspaceRoute({
      owner: context.owner,
      mcpSessionId: context.mcpSessionId,
      conversationSessionId: context.conversationSessionId,
      workspaceId,
      deviceId: binding.deviceId,
      workspaceRef: catalogEntry.workspaceRef,
      expiresAt: input.expiresAt,
    });
    const result: ConnectCloudWorkspaceResult = {
      status: "connected",
      workspaceId: route.workspaceId,
      workspaceRef: catalogEntry.workspaceRef,
      deviceId: binding.deviceId,
      displayName: catalogEntry.displayName,
      rootLabel: catalogEntry.rootLabel,
      capabilities: [...catalogEntry.capabilities],
      route,
      idempotencyKey: input.idempotencyKey,
    };

    if (input.idempotencyKey && this.auditStore) {
      await this.auditStore.recordIdempotency({
        owner: context.owner,
        action: "connect_workspace",
        status: "completed",
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        result,
      });
    } else {
      await this.auditStore?.recordEvent({ owner: context.owner, action: "connect_workspace", status: "completed", result });
    }

    return result;
  }

  private async requireCatalogEntry(
    context: DevspaceToolExecutionContext,
    deviceId: string,
    workspaceRefInput: string,
  ): Promise<CloudWorkspaceCatalogRecord> {
    const workspaceRef = workspaceRefInput.trim();
    if (!workspaceRef) throw new CloudRoutingError("INVALID_ROUTE_INPUT", "workspaceRef is required.", { details: { field: "workspaceRef" } });
    const workspaces = await this.workspaceCatalog.listWorkspaces({ owner: context.owner, deviceId });
    const entry = workspaces.find((workspace) => workspace.workspaceRef === workspaceRef);
    if (!entry) {
      throw new CloudRoutingError("WORKSPACE_NOT_FOUND", "workspaceRef is not in the selected Desktop catalog.", {
        details: { deviceId, workspaceRef },
      });
    }
    return entry;
  }
}

function deterministicWorkspaceId(input: {
  tenantId: string;
  userId: string;
  mcpSessionId: string;
  conversationSessionId?: string;
  deviceId: string;
  workspaceRef: string;
}): string {
  const digest = createHash("sha256").update(stableControlPlaneFingerprint(input)).digest("base64url").slice(0, 24);
  return `cw_${digest}`;
}
