import type { ServerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import type { CloudDeviceChannel } from "./cloud-device-channel.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import { InMemoryCloudRoutingStore } from "./cloud-routing-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import { InMemoryCloudSessionBindingService } from "./cloud-session-binding.js";
import { GatewayMcpToolExecutor } from "./gateway-mcp-tool-executor.js";
import { PostgresCloudRoutingStore } from "./postgres-cloud-routing-store.js";
import { PostgresCloudSessionBindingService } from "./postgres-cloud-session-binding.js";
import { WebSocketDeviceChannel } from "./websocket-device-channel.js";

export interface CloudGatewayRuntimeOptions {
  routingStore?: CloudRoutingStore;
  sessionBindings?: CloudSessionBindingService;
  deviceChannel?: CloudDeviceChannel;
}

export interface CloudGatewayRuntime {
  routingStore: CloudRoutingStore;
  sessionBindings: CloudSessionBindingService;
  deviceChannel: CloudDeviceChannel;
  toolExecutor: GatewayMcpToolExecutor;
  close(): Promise<void>;
}

export function createCloudGatewayRuntime(
  config: ServerConfig = loadConfig(),
  options: CloudGatewayRuntimeOptions = {},
): CloudGatewayRuntime {
  const routingStore = options.routingStore ?? createDefaultRoutingStore(config);
  const sessionBindings = options.sessionBindings ?? createDefaultSessionBindings(config, routingStore);
  const deviceChannel = options.deviceChannel ?? new WebSocketDeviceChannel();
  const toolExecutor = new GatewayMcpToolExecutor(routingStore, deviceChannel, sessionBindings);

  return {
    routingStore,
    sessionBindings,
    deviceChannel,
    toolExecutor,
    close: async () => {
      await closeIfPresent(deviceChannel);
      await closeIfPresent(sessionBindings);
      await closeIfPresent(routingStore);
    },
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

async function closeIfPresent(value: unknown): Promise<void> {
  const close = (value as { close?: () => void | Promise<void> }).close;
  if (close) await close.call(value);
}
