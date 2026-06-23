import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import type { ServerConfig } from "./config.js";
import { registerNativeAgentApiRoutes } from "./native-agent-api.js";
import type { NativeAgentStore } from "./native-agent-store.js";
import { buildHealthReport, buildReadinessReport } from "./readiness.js";

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
