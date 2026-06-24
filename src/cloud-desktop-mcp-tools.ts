import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { CloudDesktopToolService } from "./cloud-desktop-tool-service.js";
import type { DevspaceToolExecutionContext } from "./mcp-tool-executor.js";

type ToolContent = { type: "text"; text: string };

export function registerCloudDesktopMcpTools(
  server: McpServer,
  service: CloudDesktopToolService,
  getExecutionContext: () => DevspaceToolExecutionContext,
): void {
  registerAppTool(
    server,
    "connect_desktop",
    {
      title: "Connect Desktop",
      description:
        "Pair the current MCP session with an online Xautojs Desktop/local agent device. Pass deviceId when more than one Desktop is online.",
      inputSchema: {
        deviceId: z.string().optional().describe("Optional deviceId from list_devices."),
      },
      outputSchema: {
        status: z.literal("connected"),
        conversationSessionId: z.string().optional(),
        mcpSessionId: z.string(),
        deviceId: z.string(),
        connectionId: z.string().optional(),
        capabilities: z.array(z.string()),
        expiresAt: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const result = await service.connectDesktop(getExecutionContext(), input);
      return {
        content: [text(`Connected Desktop device ${result.deviceId}.`)],
        structuredContent: result,
      };
    },
  );

  registerAppTool(
    server,
    "list_devices",
    {
      title: "List Desktop devices",
      description: "List Desktop/local agent devices visible to the current Xautojs owner.",
      inputSchema: {},
      outputSchema: {
        devices: z.array(z.object({
          deviceId: z.string(),
          connectionId: z.string(),
          status: z.enum(["online", "offline"]),
          capabilities: z.array(z.string()),
          desktopInstanceId: z.string().optional(),
          agentVersion: z.string().optional(),
          connectedAt: z.string(),
          lastHeartbeatAt: z.string(),
          disconnectedAt: z.string().optional(),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const result = await service.listDevices(getExecutionContext());
      return {
        content: [text(result.devices.length === 0
          ? "No Desktop devices are registered for this owner."
          : `Found ${result.devices.length} Desktop device${result.devices.length === 1 ? "" : "s"}.`)],
        structuredContent: result,
      };
    },
  );

  registerAppTool(
    server,
    "list_workspaces",
    {
      title: "List Desktop workspaces",
      description:
        "List workspaces approved for the current Desktop device. The registered workspace catalog is not populated until the Desktop/local agent reports it.",
      inputSchema: {
        deviceId: z.string().optional().describe("Optional deviceId from list_devices."),
      },
      outputSchema: {
        deviceId: z.string().optional(),
        workspaces: z.array(z.object({
          workspaceRef: z.string(),
          displayName: z.string(),
          rootLabel: z.string(),
          capabilities: z.array(z.string()),
        })),
        catalogPending: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await service.listWorkspaces(getExecutionContext(), input);
      return {
        content: [text(result.catalogPending
          ? "Workspace catalog is not available yet; open_workspace can still route through a connected Desktop device."
          : `Found ${result.workspaces.length} workspace${result.workspaces.length === 1 ? "" : "s"}.`)],
        structuredContent: result,
      };
    },
  );
}

function text(value: string): ToolContent {
  return { type: "text", text: value };
}
