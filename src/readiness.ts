import type { ServerConfig } from "./config.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import {
  getPostgresMigrationStatus,
  toPostgresMigrationStatusJson,
  type PostgresMigrationStatus,
  type PostgresMigrationStatusJson,
} from "./db/postgres-migrations.js";

export type ProbeStatus = "ok" | "ready" | "not_ready";

export interface ProbeRuntime {
  node: string;
  platform: NodeJS.Platform;
  arch: string;
  uptimeSeconds: number;
}

export interface HealthReport {
  ok: true;
  status: "ok";
  service: "devspace";
  deploymentMode: ServerConfig["deploymentMode"];
  timestamp: string;
  runtime: ProbeRuntime;
}

export interface ReadinessReport {
  ok: boolean;
  status: "ready" | "not_ready";
  service: "devspace";
  deploymentMode: ServerConfig["deploymentMode"];
  timestamp: string;
  runtime: ProbeRuntime;
  checks: {
    config: ReadinessConfigCheck;
    database: ReadinessDatabaseCheck;
  };
}

export interface ReadinessConfigCheck {
  ok: true;
  authMode: ServerConfig["oauth"]["mode"];
  databaseProvider: ServerConfig["database"]["provider"];
  publicBaseUrl: string;
}

export type ReadinessDatabaseCheck =
  | {
      ok: true;
      provider: "sqlite";
    }
  | {
      ok: boolean;
      provider: "postgres";
      schema?: PostgresMigrationStatusJson;
      error?: string;
    };

export interface ReadinessOptions {
  now?: () => Date;
  uptimeSeconds?: () => number;
  getPostgresMigrationStatus?: (
    config: PostgresDatabaseConfig,
  ) => Promise<PostgresMigrationStatus>;
}

export function buildHealthReport(
  config: ServerConfig,
  options: ReadinessOptions = {},
): HealthReport {
  return {
    ok: true,
    status: "ok",
    service: "devspace",
    deploymentMode: config.deploymentMode,
    timestamp: nowIso(options),
    runtime: runtimeReport(options),
  };
}

export async function buildReadinessReport(
  config: ServerConfig,
  options: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const database = await databaseReadiness(config, options);
  const ok = database.ok;

  return {
    ok,
    status: ok ? "ready" : "not_ready",
    service: "devspace",
    deploymentMode: config.deploymentMode,
    timestamp: nowIso(options),
    runtime: runtimeReport(options),
    checks: {
      config: {
        ok: true,
        authMode: config.oauth.mode,
        databaseProvider: config.database.provider,
        publicBaseUrl: config.publicBaseUrl,
      },
      database,
    },
  };
}

async function databaseReadiness(
  config: ServerConfig,
  options: ReadinessOptions,
): Promise<ReadinessDatabaseCheck> {
  if (config.database.provider === "sqlite") {
    return { ok: true, provider: "sqlite" };
  }

  try {
    const loadStatus = options.getPostgresMigrationStatus ?? getPostgresMigrationStatus;
    const status = await loadStatus(config.database);
    const schema = toPostgresMigrationStatusJson(status);
    return {
      ok: schema.ready,
      provider: "postgres",
      schema,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "postgres",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runtimeReport(options: ReadinessOptions): ProbeRuntime {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: Math.round((options.uptimeSeconds?.() ?? process.uptime()) * 1000) / 1000,
  };
}

function nowIso(options: ReadinessOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}
