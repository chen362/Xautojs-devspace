import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import type {
  RemoteMcpToolName,
  RemoteMcpToolResult,
} from "./remote-mcp-tool-executor.js";
import {
  createCloudDeviceToolCallMessage,
  type CloudDeviceToolCallMessage,
} from "./cloud-device-channel-protocol.js";

export interface CloudDeviceToolCall<TInput = unknown> extends CloudDeviceToolCallMessage<TInput> {}

export interface CloudDeviceToolCancellation {
  deviceId: string;
  toolCallId: string;
  reason: string;
}

export interface CloudDeviceOfflineNotice {
  deviceId: string;
  reason?: string;
}

export interface CloudDeviceChannel {
  sendToolCall<TResult = unknown, TInput = unknown>(
    call: CloudDeviceToolCall<TInput>,
  ): Promise<RemoteMcpToolResult<TResult>>;
  cancelToolCall(input: CloudDeviceToolCancellation): Promise<void>;
  markDeviceOffline(input: CloudDeviceOfflineNotice): Promise<void>;
}

export function createCloudDeviceToolCall<TInput>(input: {
  deviceId: string;
  toolCallId: string;
  tool: RemoteMcpToolName;
  context: DevspaceToolExecutionContext;
  workspaceId?: string;
  input: TInput;
  deadlineAt?: string;
}): CloudDeviceToolCall<TInput> {
  return createCloudDeviceToolCallMessage(input);
}
