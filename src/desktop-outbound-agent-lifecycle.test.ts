import assert from "node:assert/strict";
import type { RawData } from "ws";
import { DesktopOutboundAgentLifecycle } from "./desktop-outbound-agent-lifecycle.js";
import { LocalAgentToolReceiver } from "./local-agent-receiver.js";
import type { DevspaceToolExecutor } from "./mcp-tool-executor.js";
import type { LocalAgentSocket } from "./local-agent-outbound-client.js";

class FakeSocket implements LocalAgentSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closedReasons: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedReasons.push(reason ?? "");
    this.emit("close", 1000, Buffer.from(reason ?? "closed"));
  }

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emitOpen(): void {
    this.emit("open");
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

const receiver = new LocalAgentToolReceiver({} as DevspaceToolExecutor);
const sockets: FakeSocket[] = [];
const headers: Array<Record<string, string> | undefined> = [];
const lifecycle = new DesktopOutboundAgentLifecycle();
const snapshot = lifecycle.start({
  url: "wss://gateway.example.com/cloud/devices/ws",
  authToken: "desktop-token",
  deviceId: "dev_lifecycle_a",
  desktopInstanceId: "desk_lifecycle_a",
  agentVersion: "1.2.3",
  capabilities: ["mcp-tools"],
  receiver,
  workspaceCatalogProvider: () => ({
    catalogVersion: "catalog_lifecycle_v1",
    workspaces: [{ workspaceRef: "workspace_lifecycle_a", displayName: "Lifecycle", rootLabel: "~/life", capabilities: ["read"] }],
  }),
  now: () => "2026-06-24T00:00:00.000Z",
  socketFactory: (_url, options) => {
    headers.push(options.headers);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  },
});
assert.equal(snapshot.status, "running");
assert.equal(headers[0]?.authorization, "Bearer desktop-token");
assert.equal(headers[0]?.["x-custom"], undefined);

sockets[0]?.emitOpen();
await waitFor(() => sockets[0]?.sent.some((message) => JSON.parse(message).type === "workspace.catalog") ?? false);
assert.equal(JSON.parse(sockets[0]?.sent[0] ?? "{}").type, "agent.hello");
assert.equal(JSON.parse(sockets[0]?.sent.find((message) => JSON.parse(message).type === "workspace.catalog") ?? "{}").catalogVersion, "catalog_lifecycle_v1");

const restarted = lifecycle.restart();
assert.equal(restarted.status, "running");
assert.equal(sockets[0]?.readyState, 3);
assert.equal(sockets[0]?.closedReasons.at(-1), "restarting");
assert.equal(sockets.length, 2);

const stopped = lifecycle.stop();
assert.equal(stopped.status, "stopped");
assert.equal(sockets[1]?.readyState, 3);
assert.equal(lifecycle.current().status, "stopped");

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for condition");
}
