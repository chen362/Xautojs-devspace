export type DatabaseProvider = "sqlite" | "postgres";
export type DeploymentMode = "local" | "production";
export type PostgresSslMode = "disable" | "prefer" | "require";

export interface SqliteDatabaseConfig {
  provider: "sqlite";
  stateDir: string;
  filePath: string;
}

export interface PostgresDatabaseConfig {
  provider: "postgres";
  url: string;
  sslMode: PostgresSslMode;
}

export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

export function isPostgresDatabaseConfig(config: DatabaseConfig): config is PostgresDatabaseConfig {
  return config.provider === "postgres";
}

export function isSqliteDatabaseConfig(config: DatabaseConfig): config is SqliteDatabaseConfig {
  return config.provider === "sqlite";
}
