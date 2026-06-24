import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import type {
  RemoteMcpToolError,
  RemoteMcpToolName,
} from "./remote-mcp-tool-executor.js";

export const CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION = 1;
export type CloudDeviceChannelProtocolVersion = typeof CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION;

export interface CloudDeviceAgentHelloMessage {
  type: "agent.hello";
  protocolVersion: CloudDeviceChannelProtocolVersion;
  deviceId: string;
  desktopInstanceId?: string;
  agentVersion?: string;
  capabilities: string[];
  time: string;
}

export interface CloudDeviceHeartbeatMessage {
  type: "agent.heartbeat";
  protocolVersion: CloudDeviceChannelProtocolVersion;
  deviceId: string;
  connectionId?: string;
  time: string;
}

export interface CloudDeviceToolCallMessage<TInput = unknown> {
  type: "tool.call";
  protocolVersion: CloudDeviceChannelProtocolVersion;
  deviceId: string;
  toolCallId: string;
  tool: RemoteMcpToolName;
  context: DevspaceToolExecutionContext;
  workspaceId?: string;
  input: TInput;
  deadlineAt?: string;
}

export type CloudDeviceToolResultMessage<TResult = unknown> =
  | {
      type: "tool.result";
      protocolVersion: CloudDeviceChannelProtocolVersion;
      deviceId?: string;
      toolCallId: string;
      ok: true;
      result: TResult;
    }
  | {
      type: "tool.result";
      protocolVersion: CloudDeviceChannelProtocolVersion;
      deviceId?: string;
      toolCallId: string;
      ok: false;
      error: RemoteMcpToolError;
    };

export interface CloudDeviceToolCancelMessage {
  type: "tool.cancel";
  protocolVersion: CloudDeviceChannelProtocolVersion;
  deviceId: string;
  toolCallId: string;
  reason: string;
}

export type CloudDeviceAgentMessage =
  | CloudDeviceAgentHelloMessage
  | CloudDeviceHeartbeatMessage
  | CloudDeviceToolResultMessage;

export type CloudDeviceGatewayMessage =
  | CloudDeviceToolCallMessage
  | CloudDeviceToolCancelMessage;

export function createCloudDeviceToolCallMessage<TInput>(input: {
  deviceId: string;
  toolCallId: string;
  tool: RemoteMcpToolName;
  context: DevspaceToolExecutionContext;
  workspaceId?: string;
  input: TInput;
  deadlineAt?: string;
}): CloudDeviceToolCallMessage<TInput> {
  return {
    type: "tool.call",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    toolCallId: input.toolCallId,
    tool: input.tool,
    context: {
      ...input.context,
      deviceId: input.deviceId,
      toolCallId: input.toolCallId,
    },
    workspaceId: input.workspaceId,
    input: input.input,
    deadlineAt: input.deadlineAt,
  };
}

export function createCloudDeviceToolCancelMessage(input: {
  deviceId: string;
  toolCallId: string;
  reason: string;
}): CloudDeviceToolCancelMessage {
  return {
    type: "tool.cancel",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    toolCallId: input.toolCallId,
    reason: input.reason,
  };
}

export function createCloudDeviceToolResultMessage<TResult>(input: {
  deviceId?: string;
  toolCallId: string;
  result: TResult;
}): CloudDeviceToolResultMessage<TResult> {
  return {
    type: "tool.result",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    toolCallId: input.toolCallId,
    ok: true,
    result: input.result,
  };
}

export function createCloudDeviceToolErrorMessage(input: {
  deviceId?: string;
  toolCallId: string;
  error: RemoteMcpToolError;
}): CloudDeviceToolResultMessage<never> {
  return {
    type: "tool.result",
    protocolVersion: CLOUD_DEVICE_CHANNEL_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    toolCallId: input.toolCallId,
    ok: false,
    error: input.error,
  };
}
