import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { ServerConfig } from "./config.js";
import { registerNativeAgentApiRoutes } from "./native-agent-api.js";
import type { NativeAgentStore } from "./native-agent-store.js";
import { buildHealthReport, buildReadinessReport } from "./readiness.js";

const CORS_METHODS = "GET,POST,DELETE,OPTIONS";
const CORS_HEADERS = "authorization,content-type,x-request-id";

export interface OperatorServerOptions {
  store?: NativeAgentStore;
  operatorToken?: string;
  operatorSessionSecret?: string;
  operatorSessionTtlSeconds?: number;
}

export interface RunningOperatorServer {
  app: Express;
  config: ServerConfig;
  close(): Promise<void>;
}

export interface StartedOperatorServer extends RunningOperatorServer {
  server: Server;
  url: string;
  apiBasePath: "/api/native-agent";
  readyUrl: string;
  close(): Promise<void>;
}

export function createOperatorServer(
  config: ServerConfig,
  options: OperatorServerOptions = {},
): RunningOperatorServer {
  const app = express();
  installLocalDesktopCors(app);
  const nativeAgentRoutes = registerNativeAgentApiRoutes(app, config, {
    store: options.store,
    operatorToken: options.operatorToken,
    operatorSessionSecret: options.operatorSessionSecret,
    operatorSessionTtlSeconds: options.operatorSessionTtlSeconds,
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", true);
  }

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json(buildHealthReport(config));
  });

  app.get("/readyz", async (_request: Request, response: Response) => {
    const report = await buildReadinessReport(config);
    response.status(report.ok ? 200 : 503).json(report);
  });

  return {
    app,
    config,
    async close(): Promise<void> {
      await nativeAgentRoutes.close();
    },
  };
}

export async function startOperatorServer(
  config: ServerConfig,
  options: OperatorServerOptions = {},
): Promise<StartedOperatorServer> {
  const running = createOperatorServer(config, options);
  const server = await listen(running.app, config.host, config.port);
  const url = localHttpUrl(config.host, config.port);

  return {
    ...running,
    server,
    url,
    apiBasePath: "/api/native-agent",
    readyUrl: `${url}/readyz`,
    close: async () => {
      await closeHttpServer(server);
      await running.close();
    },
  };
}

function installLocalDesktopCors(app: Express): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const origin = request.headers.origin;
    if (isAllowedLocalDesktopOrigin(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
      response.setHeader("Access-Control-Allow-Headers", CORS_HEADERS);
      response.setHeader("Access-Control-Expose-Headers", "x-request-id");
      response.setHeader("Access-Control-Max-Age", "600");
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
      }
    }
    next();
  });
}

function isAllowedLocalDesktopOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string" || !origin.trim()) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "tauri:" && parsed.hostname === "localhost") return true;
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname === "tauri.localhost") return true;
    if (parsed.protocol !== "http:") return false;
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function listen(app: Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function localHttpUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}
