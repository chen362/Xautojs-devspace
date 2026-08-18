import { randomUUID } from "node:crypto";
import type {
  CloudDeviceChannel,
  CloudDeviceOfflineNotice,
  CloudDeviceToolCall,
  CloudDeviceToolCancellation,
} from "./cloud-device-channel.js";
import {
  createCloudDeviceToolCancelMessage,
  type CloudDeviceAgentMessage,
  type CloudDeviceGatewayMessage,
} from "./cloud-device-channel-protocol.js";
import type {
  RemoteMcpToolError,
  RemoteMcpToolResult,
} from "./remote-mcp-tool-executor.js";

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

export interface CloudDeviceConnection {
  send(message: CloudDeviceGatewayMessage): void | Promise<void>;
  close?(reason?: string): void | Promise<void>;
}

export interface CloudDeviceConnectionRecord {
  connectionId: string;
  deviceId: string;
  connectedAt: string;
  lastSeenAt: string;
  capabilities: string[];
}

export interface RegisterCloudDeviceConnectionInput {
  deviceId: string;
  connection: CloudDeviceConnection;
  connectionId?: string;
  capabilities?: readonly string[];
  now?: string;
}

export interface WebSocketDeviceChannelOptions {
  toolCallTimeoutMs?: number;
}

interface RegisteredConnection extends CloudDeviceConnectionRecord {
  connection: CloudDeviceConnection;
}

interface PendingToolCall {
  deviceId: string;
  timeout: NodeJS.Timeout;
  resolve(result: RemoteMcpToolResult<unknown>): void;
}

export class WebSocketDeviceChannel implements CloudDeviceChannel {
  private readonly connections = new Map<string, RegisteredConnection>();
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly toolCallTimeoutMs: number;

  constructor(options: WebSocketDeviceChannelOptions = {}) {
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  }

  registerConnection(input: RegisterCloudDeviceConnectionInput): CloudDeviceConnectionRecord {
    const now = input.now ?? new Date().toISOString();
    const record: RegisteredConnection = {
      deviceId: input.deviceId,
      connectionId: input.connectionId ?? `conn_${randomUUID()}`,
      connectedAt: now,
      lastSeenAt: now,
      capabilities: normalizeCapabilities(input.capabilities),
      connection: input.connection,
    };
    this.connections.set(record.deviceId, record);
    return publicConnectionRecord(record);
  }

  getConnection(deviceId: string): CloudDeviceConnectionRecord | undefined {
    const record = this.connections.get(deviceId);
    return record ? publicConnectionRecord(record) : undefined;
  }

  unregisterConnection(deviceId: string, reason = "device_disconnected"): void {
    const record = this.connections.get(deviceId);
    this.connections.delete(deviceId);
    this.rejectPendingForDevice(deviceId, {
      code: "AGENT_DISCONNECTED",
      message: `Device channel closed: ${reason}`,
      retryable: true,
      details: { deviceId, connectionId: record?.connectionId },
    });
  }

  async sendToolCall<TResult = unknown, TInput = unknown>(
    call: CloudDeviceToolCall<TInput>,
  ): Promise<RemoteMcpToolResult<TResult>> {
    const record = this.connections.get(call.deviceId);
    if (!record) {
      return {
        ok: false,
        error: {
          code: "AGENT_DISCONNECTED",
          message: "Device channel is not connected.",
          retryable: true,
          details: { deviceId: call.deviceId },
        },
      };
    }

    return new Promise<RemoteMcpToolResult<TResult>>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingToolCalls.delete(call.toolCallId);
        resolve({
          ok: false,
          error: {
            code: "TOOL_TIMEOUT",
            message: "Device tool call timed out.",
            retryable: true,
            details: { deviceId: call.deviceId, toolCallId: call.toolCallId },
          },
        });
      }, this.toolCallTimeoutMs);

      this.pendingToolCalls.set(call.toolCallId, {
        deviceId: call.deviceId,
        timeout,
        resolve: (result) => resolve(result as RemoteMcpToolResult<TResult>),
      });

      void Promise.resolve(record.connection.send(call)).catch((error: unknown) => {
        clearTimeout(timeout);
        this.pendingToolCalls.delete(call.toolCallId);
        resolve({
          ok: false,
          error: {
            code: "AGENT_DISCONNECTED",
            message: error instanceof Error ? error.message : "Device channel send failed.",
            retryable: true,
            details: { deviceId: call.deviceId, toolCallId: call.toolCallId },
          },
        });
      });
    });
  }

  async cancelToolCall(input: CloudDeviceToolCancellation): Promise<void> {
    const record = this.connections.get(input.deviceId);
    if (!record) return;
    await record.connection.send(createCloudDeviceToolCancelMessage(input));
  }

  async markDeviceOffline(input: CloudDeviceOfflineNotice): Promise<void> {
    const record = this.connections.get(input.deviceId);
    this.unregisterConnection(input.deviceId, input.reason ?? "device_offline");
    await record?.connection.close?.(input.reason ?? "device_offline");
  }

  handleDeviceMessage(message: CloudDeviceAgentMessage): void {
    switch (message.type) {
      case "agent.hello":
      case "agent.heartbeat": {
        const existing = this.connections.get(message.deviceId);
        if (existing) {
          existing.lastSeenAt = message.time;
          if (message.type === "agent.hello") existing.capabilities = normalizeCapabilities(message.capabilities);
        }
        return;
      }
      case "tool.result": {
        const pending = this.pendingToolCalls.get(message.toolCallId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(message.toolCallId);
        pending.resolve(message.ok
          ? { ok: true, result: message.result }
          : { ok: false, error: message.error });
        return;
      }
    }
  }

  close(): void {
    for (const deviceId of this.connections.keys()) {
      this.unregisterConnection(deviceId, "channel_closed");
    }
  }

  private rejectPendingForDevice(deviceId: string, error: RemoteMcpToolError): void {
    for (const [toolCallId, pending] of this.pendingToolCalls.entries()) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timeout);
      this.pendingToolCalls.delete(toolCallId);
      pending.resolve({ ok: false, error });
    }
  }
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set((capabilities ?? []).map((capability) => capability.trim()).filter(Boolean))].sort();
}

function publicConnectionRecord(record: RegisteredConnection): CloudDeviceConnectionRecord {
  return {
    connectionId: record.connectionId,
    deviceId: record.deviceId,
    connectedAt: record.connectedAt,
    lastSeenAt: record.lastSeenAt,
    capabilities: [...record.capabilities],
  };
}
