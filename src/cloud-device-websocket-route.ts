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

function isHelloMessage(value: unknown): value is CloudDeviceAgentHelloMessage {
  if (!isRecord(value)) return false;
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

function isHeartbeatMessage(value: unknown): value is CloudDeviceHeartbeatMessage {
  if (!isRecord(value)) return false;
  return (
    value.type === "agent.heartbeat" &&
    typeof value.deviceId === "string" &&
    typeof value.time === "string" &&
    (value.connectionId === undefined || typeof value.connectionId === "string")
  );
}

function isWorkspaceCatalogMessage(value: unknown): value is CloudDeviceWorkspaceCatalogMessage {
  if (!isRecord(value)) return false;
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
