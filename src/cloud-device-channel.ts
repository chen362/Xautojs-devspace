import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";
import type {
  RemoteMcpToolCall,
  RemoteMcpToolName,
  RemoteMcpToolResult,
} from "./remote-mcp-tool-executor.js";

export interface CloudDeviceToolCall<TInput = unknown> extends RemoteMcpToolCall<TInput> {
  deviceId: string;
  deadlineAt?: string;
}

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
  return {
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
