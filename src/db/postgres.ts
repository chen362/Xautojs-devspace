import type { DatabaseConfig, PostgresDatabaseConfig } from "./types.js";

export class PostgresDatabaseRequiredError extends Error {
  constructor(provider: DatabaseConfig["provider"]) {
    super(`Postgres database config is required, received ${provider}.`);
    this.name = "PostgresDatabaseRequiredError";
  }
}

export function requirePostgresDatabaseConfig(config: DatabaseConfig): PostgresDatabaseConfig {
  if (config.provider !== "postgres") {
    throw new PostgresDatabaseRequiredError(config.provider);
  }
  return config;
}

export function redactPostgresUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "***";
  if (parsed.username) parsed.username = "***";
  return parsed.toString();
}

export function postgresConnectionSummary(config: PostgresDatabaseConfig): {
  provider: "postgres";
  url: string;
  sslMode: PostgresDatabaseConfig["sslMode"];
} {
  return {
    provider: "postgres",
    url: redactPostgresUrl(config.url),
    sslMode: config.sslMode,
  };
}
