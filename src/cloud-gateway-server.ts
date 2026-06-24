import type { Express, Request } from "express";
import type { ServerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import type { CloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import { InMemoryCloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import type { CloudDeviceChannel } from "./cloud-device-channel.js";
import type { CloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import { InMemoryCloudDeviceConnectionStore } from "./cloud-device-connection-store.js";
import type { CloudDeviceCodeApiOptions, RegisteredCloudDeviceCodeApiRoutes } from "./cloud-device-code-api.js";
import { registerCloudDeviceCodeApiRoutes } from "./cloud-device-code-api.js";
import { CloudDesktopToolService } from "./cloud-desktop-tool-service.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import type { CloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import { InMemoryCloudWorkspaceCatalogStore } from "./cloud-workspace-catalog-store.js";
import { CloudWorkspaceSelectionService } from "./cloud-workspace-selection-service.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import { LOCAL_WORKSPACE_IDENTITY, type WorkspaceIdentity } from "./identity.js";
import { PostgresCloudControlPlaneAuditStore } from "./postgres-cloud-control-plane-audit-store.js";
import { PostgresCloudDeviceConnectionStore } from "./postgres-cloud-device-connection-store.js";
import { PostgresCloudRoutingStore } from "./postgres-cloud-routing-store.js";
import { PostgresCloudSessionBindingService } from "./postgres-cloud-session-binding.js";
import { PostgresCloudWorkspaceCatalogStore } from "./postgres-cloud-workspace-catalog-store.js";
import { WebSocketDeviceChannel } from "./websocket-device-channel.js";

export interface CloudGatewayRuntimeOptions {
  routingStore?: CloudRoutingStore;
  sessionBindings?: CloudSessionBindingService;
  deviceChannel?: CloudDeviceChannel;
  deviceConnectionStore?: CloudDeviceConnectionStore;
  workspaceCatalogStore?: CloudWorkspaceCatalogStore;
  auditStore?: CloudControlPlaneAuditStore;
  workspaceSelectionService?: CloudWorkspaceSelectionService;
  desktopToolService?: CloudDesktopToolService;
}

export interface CloudGatewayRuntime {
  routingStore: CloudRoutingStore;
  sessionBindings: CloudSessionBindingService;
  deviceChannel: CloudDeviceChannel;
  deviceConnectionStore: CloudDeviceConnectionStore;
  workspaceCatalogStore: CloudWorkspaceCatalogStore;
  auditStore: CloudControlPlaneAuditStore;
  workspaceSelectionService: CloudWorkspaceSelectionService;
  desktopToolService: CloudDesktopToolService;
  toolExecutor: GatewayMcpToolExecutor;
  close(): Promise<void>;
}

export interface CloudGatewayHttpRoutesOptions {
  deviceCode?: Omit<CloudDeviceCodeApiOptions, "auditStore" | "resolveOwner"> & {
    resolveOwner?: CloudDeviceCodeApiOptions["resolveOwner"];
  };
}

export interface RegisteredCloudGatewayHttpRoutes {
  deviceCode: RegisteredCloudDeviceCodeApiRoutes;
  close(): Promise<void>;
}

export function createCloudGatewayRuntime(
  config: ServerConfig = loadConfig(),
  options: CloudGatewayRuntimeOptions = {},
): CloudGatewayRuntime {
  const routingStore = options.routingStore ?? createDefaultRoutingStore(config);
  const sessionBindings = options.sessionBindings ?? createDefaultSessionBindings(config, routingStore);
  const deviceChannel = options.deviceChannel ?? new WebSocketDeviceChannel();
  const deviceConnectionStore = options.deviceConnectionStore ?? createDefaultDeviceConnectionStore(config);
  const workspaceCatalogStore = options.workspaceCatalogStore ?? createDefaultWorkspaceCatalogStore(config);
  const auditStore = options.auditStore ?? createDefaultAuditStore(config);
  const workspaceSelectionService = options.workspaceSelectionService ?? new CloudWorkspaceSelectionService(
    sessionBindings,
    routingStore,
    workspaceCatalogStore,
    auditStore,
  );
  const desktopToolService = options.desktopToolService ?? new CloudDesktopToolService(
    sessionBindings,
    deviceConnectionStore,
    workspaceCatalogStore,
    workspaceSelectionService,
  );
  const toolExecutor = new GatewayMcpToolExecutor(routingStore, deviceChannel, sessionBindings);

  return {
    routingStore,
    sessionBindings,
    deviceChannel,
    deviceConnectionStore,
    workspaceCatalogStore,
    auditStore,
    workspaceSelectionService,
    desktopToolService,
    toolExecutor,
    close: async () => {
      await closeIfPresent(deviceChannel);
      await closeIfPresent(deviceConnectionStore);
      await closeIfPresent(workspaceCatalogStore);
      await closeIfPresent(auditStore);
      await closeIfPresent(sessionBindings);
      await closeIfPresent(routingStore);
    },
  };
}

export function registerCloudGatewayHttpRoutes(
  app: Express,
  runtime: CloudGatewayRuntime,
  config: ServerConfig = loadConfig(),
  options: CloudGatewayHttpRoutesOptions = {},
): RegisteredCloudGatewayHttpRoutes {
  const deviceCode = registerCloudDeviceCodeApiRoutes(app, config, {
    ...options.deviceCode,
    auditStore: runtime.auditStore,
    resolveOwner: options.deviceCode?.resolveOwner ?? createDefaultDeviceCodeOwnerResolver(config),
  });

  return {
    deviceCode,
    close: () => deviceCode.close(),
  };
}

function createDefaultRoutingStore(config: ServerConfig): CloudRoutingStore {
  if (isPostgresDatabaseConfig(config.database)) return new PostgresCloudRoutingStore(config.database);
  return new InMemoryCloudRoutingStore();
}

function createDefaultSessionBindings(
  config: ServerConfig,
  routingStore: CloudRoutingStore,
): CloudSessionBindingService {
  if (isPostgresDatabaseConfig(config.database)) {
    return new PostgresCloudSessionBindingService(config.database, routingStore);
  }
  return new InMemoryCloudSessionBindingService(routingStore);
}

function createDefaultDeviceConnectionStore(config: ServerConfig): CloudDeviceConnectionStore {
  if (isPostgresDatabaseConfig(config.database)) return new PostgresCloudDeviceConnectionStore(config.database);
  return new InMemoryCloudDeviceConnectionStore();
}

function createDefaultWorkspaceCatalogStore(config: ServerConfig): CloudWorkspaceCatalogStore {
  if (isPostgresDatabaseConfig(config.database)) return new PostgresCloudWorkspaceCatalogStore(config.database);
  return new InMemoryCloudWorkspaceCatalogStore();
}

function createDefaultAuditStore(config: ServerConfig): CloudControlPlaneAuditStore {
  if (isPostgresDatabaseConfig(config.database)) return new PostgresCloudControlPlaneAuditStore(config.database);
  return new InMemoryCloudControlPlaneAuditStore();
}

function createDefaultDeviceCodeOwnerResolver(config: ServerConfig): (request: Request) => WorkspaceIdentity | undefined {
  return (request) => {
    if (config.oauth.mode === "owner-token" && bearerToken(request) === config.oauth.ownerToken) {
      return LOCAL_WORKSPACE_IDENTITY;
    }

    const tenantId = request.header("x-devspace-tenant-id")?.trim();
    const userId = request.header("x-devspace-user-id")?.trim();
    if (tenantId && userId) return { tenantId, userId };
    return undefined;
  };
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.header("authorization")?.trim();
  const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : undefined;
  return match?.[1]?.trim();
}

async function closeIfPresent(value: unknown): Promise<void> {
  const close = (value as { close?: () => void | Promise<void> }).close;
  if (close) await close.call(value);
}
