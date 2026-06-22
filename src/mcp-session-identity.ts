import { identityMatches, type WorkspaceIdentity } from "./identity.js";

export class McpSessionIdentityMismatchError extends Error {
  constructor(sessionId: string) {
    super(`MCP session identity mismatch: ${sessionId}`);
    this.name = "McpSessionIdentityMismatchError";
  }
}

export function assertMcpSessionIdentity(input: {
  sessionId: string;
  sessionOwner: WorkspaceIdentity;
  requestOwner: WorkspaceIdentity;
}): void {
  if (!identityMatches(input.sessionOwner, input.requestOwner)) {
    throw new McpSessionIdentityMismatchError(input.sessionId);
  }
}
