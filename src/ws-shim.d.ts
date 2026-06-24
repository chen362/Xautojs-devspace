declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    constructor(address: string | URL, options?: { headers?: Record<string, string> });
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer?: boolean });
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (websocket: WebSocket) => void,
    ): void;
    emit(event: "connection", websocket: WebSocket, request: IncomingMessage): boolean;
    close(callback?: () => void): void;
  }
}
