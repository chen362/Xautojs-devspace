import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { CloudGatewayRuntime } from "./cloud-gateway-server.js";
import type { CloudDeviceConnection } from "./websocket-device-channel.js";
import { WebSocketDeviceChannel } from "./websocket-device-channel.js";
import {
  CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  type CloudDeviceAgentMessage,
  type CloudDeviceGatewayMessage,
  type CloudDeviceAgentHelloMessage,
  type CloudDeviceHeartbeatMessage,
  type CloudDeviceWorkspaceCatalogMessage,
} from "./cloud-device-channel-protocol.js";
import type { WorkspaceIdentity } from "./identity.js";

export interface CloudDeviceWebSocketAuthContext {
  owner: WorkspaceIdentity;
  deviceId?: string;
  desktopInstanceId?: string;
  expiresAt?: string;
}

export type CloudDeviceWebSocketAuthenticator = (
  request: IncomingMessage,
) => Promise<CloudDeviceWebSocketAuthContext | undefined> | CloudDeviceWebSocketAuthContext | undefined;

export interface AttachCloudDeviceWebSocketRouteInput {
  server: HttpServer;
  runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel };
  authenticate: CloudDeviceWebSocketAuthenticator;
  path?: string;
}

export interface AttachedCloudDeviceWebSocketRoute {
  path: string;
  close(): void;
}

export function attachCloudDeviceWebSocketRoute(
  input: AttachCloudDeviceWebSocketRouteInput,
): AttachedCloudDeviceWebSocketRoute {
  const path = input.path ?? "/cloud/devices/ws";
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!matchesPath(request, path)) return;

    let auth: CloudDeviceWebSocketAuthContext | undefined;
    try {
      auth = await input.authenticate(request);
    } catch {
      socket.destroy();
      return;
    }

    if (!auth) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
      void handleDeviceSocket({ websocket, auth, runtime: input.runtime });
    });
  };

  input.server.on("upgrade", onUpgrade);

  return {
    path,
    close: () => {
      input.server.off("upgrade", onUpgrade);
      wss.close();
    },
  };
}

async function handleDeviceSocket(input: {
  websocket: WebSocket;
  auth: CloudDeviceWebSocketAuthContext;
  runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel };
}): Promise<void> {
  let hello: CloudDeviceAgentHelloMessage | undefined;
  let connectionId: string | undefined;

  const connection: CloudDeviceConnection = {
    send: (message: CloudDeviceGatewayMessage) => {
      if (input.websocket.readyState === WebSocket.OPEN) input.websocket.send(JSON.stringify(message));
    },
    close: (reason?: string) => {
      input.websocket.close(1000, reason);
    },
  };

  input.websocket.on("message", (data) => {
    void (async () => {
      const message = parseAgentMessage(data);
      if (!message) {
        input.websocket.close(1003, "invalid_message");
        return;
      }

      if (!hello) {
        if (message.type !== "agent.hello") {
          input.websocket.close(1008, "hello_required");
          return;
        }
        if (!helloMatchesAuth(message, input.auth)) {
          input.websocket.close(1008, "auth_device_mismatch");
          return;
        }

        hello = message;
        await input.runtime.routingStore.registerDevice({
          owner: input.auth.owner,
          deviceId: message.deviceId,
          capabilities: message.capabilities,
          status: "online",
          now: message.time,
          expiresAt: input.auth.expiresAt,
        });
        const registered = input.runtime.deviceChannel.registerConnection({
          deviceId: message.deviceId,
          connection,
          capabilities: message.capabilities,
          now: message.time,
        });
        const registeredConnectionId = registered.connectionId;
        connectionId = registeredConnectionId;
        await input.runtime.deviceConnectionStore.recordConnected({
          owner: input.auth.owner,
          deviceId: message.deviceId,
          connectionId: registeredConnectionId,
          capabilities: message.capabilities,
          desktopInstanceId: message.desktopInstanceId,
          agentVersion: message.agentVersion,
          now: message.time,
        });
        input.runtime.deviceChannel.handleDeviceMessage(message);
        return;
      }

      if (message.deviceId && message.deviceId !== hello.deviceId) {
        input.websocket.close(1008, "device_mismatch");
        return;
      }

      if (message.type === "agent.heartbeat") {
        await handleHeartbeat({
          message,
          owner: input.auth.owner,
          runtime: input.runtime,
          connectionId,
        });
        return;
      }

      if (message.type === "workspace.catalog") {
        await handleWorkspaceCatalog({
          message,
          owner: input.auth.owner,
          runtime: input.runtime,
        });
        return;
      }

      input.runtime.deviceChannel.handleDeviceMessage(message);
    })().catch(() => {
      input.websocket.close(1011, "gateway_error");
    });
  });

  input.websocket.on("close", () => {
    void (async () => {
      if (!hello || !connectionId) return;
      input.runtime.deviceChannel.unregisterConnection(hello.deviceId, "websocket_closed");
      await input.runtime.routingStore.setDeviceStatus({
        owner: input.auth.owner,
        deviceId: hello.deviceId,
        status: "offline",
      }).catch(() => undefined);
      await input.runtime.deviceConnectionStore.recordDisconnected({
        owner: input.auth.owner,
        deviceId: hello.deviceId,
        connectionId,
      }).catch(() => undefined);
    })();
  });
}

async function handleHeartbeat(input: {
  message: CloudDeviceHeartbeatMessage;
  owner: WorkspaceIdentity;
  runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel };
  connectionId?: string;
}): Promise<void> {
  input.runtime.deviceChannel.handleDeviceMessage(input.message);
  await input.runtime.routingStore.setDeviceStatus({
    owner: input.owner,
    deviceId: input.message.deviceId,
    status: "online",
    now: input.message.time,
  });
  if (input.connectionId) {
    await input.runtime.deviceConnectionStore.recordHeartbeat({
      owner: input.owner,
      deviceId: input.message.deviceId,
      connectionId: input.connectionId,
      now: input.message.time,
    });
  }
}

async function handleWorkspaceCatalog(input: {
  message: CloudDeviceWorkspaceCatalogMessage;
  owner: WorkspaceIdentity;
  runtime: CloudGatewayRuntime & { deviceChannel: WebSocketDeviceChannel };
}): Promise<void> {
  await input.runtime.workspaceCatalogStore.recordCatalog({
    owner: input.owner,
    deviceId: input.message.deviceId,
    catalogVersion: input.message.catalogVersion,
    workspaces: input.message.workspaces,
    now: input.message.time,
  });
}

function helloMatchesAuth(message: CloudDeviceAgentHelloMessage, auth: CloudDeviceWebSocketAuthContext): boolean {
  if (auth.deviceId && auth.deviceId !== message.deviceId) return false;
  if (auth.desktopInstanceId && auth.desktopInstanceId !== message.desktopInstanceId) return false;
  return true;
}

function matchesPath(request: IncomingMessage, path: string): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname === path;
}

function parseAgentMessage(data: RawData): CloudDeviceAgentMessage | undefined {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return isAgentMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isAgentMessage(value: unknown): value is CloudDeviceAgentMessage {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION) return false;
  if (typeof value.type !== "string") return false;
  if (value.type === "agent.hello") return isHelloMessage(value);
  if (value.type === "agent.heartbeat") return isHeartbeatMessage(value);
  if (value.type === "workspace.catalog") return isWorkspaceCatalogMessage(value);
  if (value.type === "tool.result") return isToolResultMessage(value);
  return false;
}

function isHelloMessage(value: Record<string, unknown>): value is CloudDeviceAgentHelloMessage {
  return (
    value.type === "agent.hello" &&
    typeof value.deviceId === "string" &&
    typeof value.time === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string") &&
    (value.desktopInstanceId === undefined || typeof value.desktopInstanceId === "string") &&
    (value.agentVersion === undefined || typeof value.agentVersion === "string")
  );
}

function isHeartbeatMessage(value: Record<string, unknown>): value is CloudDeviceHeartbeatMessage {
  return (
    value.type === "agent.heartbeat" &&
    typeof value.deviceId === "string" &&
    typeof value.time === "string" &&
    (value.connectionId === undefined || typeof value.connectionId === "string")
  );
}

function isWorkspaceCatalogMessage(value: Record<string, unknown>): value is CloudDeviceWorkspaceCatalogMessage {
  return (
    value.type === "workspace.catalog" &&
    typeof value.deviceId === "string" &&
    typeof value.time === "string" &&
    (value.catalogVersion === undefined || typeof value.catalogVersion === "string") &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(isWorkspaceCatalogEntry)
  );
}

function isWorkspaceCatalogEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.workspaceRef === "string" &&
    typeof value.displayName === "string" &&
    typeof value.rootLabel === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string")
  );
}

function isToolResultMessage(value: Record<string, unknown>): boolean {
  return (
    value.type === "tool.result" &&
    typeof value.toolCallId === "string" &&
    typeof value.ok === "boolean" &&
    (value.deviceId === undefined || typeof value.deviceId === "string") &&
    (value.ok ? "result" in value : isRecord(value.error))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
