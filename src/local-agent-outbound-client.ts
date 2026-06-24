import { WebSocket, type RawData } from "ws";
import { LocalAgentToolReceiver } from "./local-agent-receiver.js";
import {
  CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
  type CloudDeviceGatewayMessage,
  type CloudDeviceHeartbeatMessage,
  type CloudDeviceAgentHelloMessage,
  type CloudDeviceToolResultMessage,
} from "./cloud-device-channel-protocol.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface LocalAgentSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type LocalAgentSocketFactory = (
  url: string,
  options: { headers?: Record<string, string> },
) => LocalAgentSocket;

export interface LocalAgentOutboundClientOptions {
  url: string;
  deviceId: string;
  receiver: LocalAgentToolReceiver;
  capabilities?: readonly string[];
  desktopInstanceId?: string;
  agentVersion?: string;
  headers?: Record<string, string>;
  heartbeatIntervalMs?: number;
  socketFactory?: LocalAgentSocketFactory;
  now?: () => string;
}

export class LocalAgentOutboundClient {
  private socket: LocalAgentSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly now: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly socketFactory: LocalAgentSocketFactory;

  constructor(private readonly options: LocalAgentOutboundClientOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.socketFactory = options.socketFactory ?? createWsSocket;
  }

  start(): void {
    if (this.socket) return;

    const socket = this.socketFactory(this.options.url, { headers: this.options.headers });
    this.socket = socket;
    socket.on("open", () => {
      this.sendHello();
      this.startHeartbeat();
    });
    socket.on("message", (data) => {
      void this.handleGatewayMessage(data);
    });
    socket.on("close", () => {
      this.stopHeartbeat();
      this.socket = undefined;
    });
    socket.on("error", () => undefined);
  }

  stop(reason = "client_stopped"): void {
    const socket = this.socket;
    this.socket = undefined;
    this.stopHeartbeat();
    socket?.close(1000, reason);
  }

  private sendHello(): void {
    const message: CloudDeviceAgentHelloMessage = {
      type: "agent.hello",
      protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
      deviceId: this.options.deviceId,
      desktopInstanceId: this.options.desktopInstanceId,
      agentVersion: this.options.agentVersion,
      capabilities: normalizeCapabilities(this.options.capabilities),
      time: this.now(),
    };
    this.sendJson(message);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sendHeartbeat = () => {
      const message: CloudDeviceHeartbeatMessage = {
        type: "agent.heartbeat",
        protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
        deviceId: this.options.deviceId,
        time: this.now(),
      };
      this.sendJson(message);
    };
    this.heartbeat = setInterval(sendHeartbeat, this.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async handleGatewayMessage(data: RawData): Promise<void> {
    const message = parseGatewayMessage(data);
    if (!message) return;
    const response = await this.options.receiver.handleGatewayMessage(message);
    if (response) this.sendJson(response);
  }

  private sendJson(message: CloudDeviceAgentHelloMessage | CloudDeviceHeartbeatMessage | CloudDeviceToolResultMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }
}

function createWsSocket(url: string, options: { headers?: Record<string, string> }): LocalAgentSocket {
  return new WebSocket(url, { headers: options.headers });
}

function parseGatewayMessage(data: RawData): CloudDeviceGatewayMessage | undefined {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return isGatewayMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isGatewayMessage(value: unknown): value is CloudDeviceGatewayMessage {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION) return false;
  if (value.type === "tool.cancel") {
    return (
      typeof value.deviceId === "string" &&
      typeof value.toolCallId === "string" &&
      typeof value.reason === "string"
    );
  }
  if (value.type === "tool.call") {
    return (
      typeof value.deviceId === "string" &&
      typeof value.toolCallId === "string" &&
      typeof value.tool === "string" &&
      isRecord(value.context) &&
      "input" in value
    );
  }
  return false;
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set((capabilities ?? []).map((capability) => capability.trim()).filter(Boolean))].sort();
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
