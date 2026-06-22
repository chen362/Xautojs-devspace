import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import type { DatabaseConfig, DatabaseProvider, DeploymentMode, PostgresSslMode } from "./db/types.js";
import { loadDevspaceFiles } from "./user-config.js";

export type ToolNamingMode = "legacy" | "short";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OIDC_CLOCK_TOLERANCE_SECONDS = 30;
const DEFAULT_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS = 60 * 60;

export interface ServerConfig {
  host: string;
  port: number;
  deploymentMode: DeploymentMode;
  oauth: OAuthConfig;
  database: DatabaseConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  minimalTools: boolean;
  toolNaming: ToolNamingMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  workspaceSessionTtlSeconds: number | null;
  workspaceSessionCleanupIntervalSeconds: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  agentDir: string;
  logging: LoggingConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseMinimalTools(env: NodeJS.ProcessEnv): boolean {
  if (env.DEVSPACE_TOOL_MODE === "minimal") return true;
  if (env.DEVSPACE_TOOL_MODE === "full") return false;
  if (env.DEVSPACE_TOOL_MODE) {
    throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${env.DEVSPACE_TOOL_MODE}`);
  }
  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS);
  return true;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => resolve(expandHomePath(entry))) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | null {
  if (!value) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseToolNaming(value: string | undefined): ToolNamingMode {
  if (!value || value === "short") return "short";
  if (value === "legacy") return "legacy";

  throw new Error(`Invalid DEVSPACE_TOOL_NAMING: ${value}`);
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  if (!value || value === "local") return "local";
  if (value === "production") return "production";

  throw new Error(`Invalid DEVSPACE_DEPLOYMENT_MODE: ${value}`);
}

function parseAuthMode(value: string | undefined): OAuthConfig["mode"] {
  if (!value || value === "owner-token") return "owner-token";
  if (value === "oidc") return "oidc";

  throw new Error(`Invalid DEVSPACE_AUTH_MODE: ${value}`);
}

function parseDatabaseProvider(value: string | undefined): DatabaseProvider {
  if (!value || value === "sqlite") return "sqlite";
  if (value === "postgres") return "postgres";

  throw new Error(`Invalid DEVSPACE_DATABASE_PROVIDER: ${value}`);
}

function parsePostgresSslMode(value: string | undefined): PostgresSslMode {
  if (!value || value === "prefer") return "prefer";
  if (value === "disable" || value === "require") return value;

  throw new Error(`Invalid DEVSPACE_POSTGRES_SSL_MODE: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseRequiredString(value: string | undefined, name: string): string {
  const parsed = value?.trim();
  if (!parsed) throw new Error(`${name} is required.`);
  return parsed;
}

function parseUrlString(value: string | undefined, name: string): string {
  const raw = parseRequiredString(value, name);
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
}

function defaultJwksUri(issuer: string): string {
  return new URL(".well-known/jwks.json", `${issuer}/`).toString();
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined, stateDir: string): OAuthConfig {
  const mode = parseAuthMode(env.DEVSPACE_AUTH_MODE);
  const scopes = parseStringList(env.DEVSPACE_OAUTH_SCOPES ?? env.DEVSPACE_OIDC_SCOPES, ["devspace"]);
  const common = {
    mode,
    stateDir,
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes,
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };

  if (mode === "oidc") {
    const issuer = parseUrlString(env.DEVSPACE_OIDC_ISSUER, "DEVSPACE_OIDC_ISSUER");
    return {
      ...common,
      mode,
      oidc: {
        issuer,
        audience: parseRequiredString(env.DEVSPACE_OIDC_AUDIENCE, "DEVSPACE_OIDC_AUDIENCE"),
        jwksUri: env.DEVSPACE_OIDC_JWKS_URI
          ? parseUrlString(env.DEVSPACE_OIDC_JWKS_URI, "DEVSPACE_OIDC_JWKS_URI")
          : defaultJwksUri(issuer),
        userClaim: env.DEVSPACE_OIDC_USER_CLAIM?.trim() || "sub",
        tenantClaim: env.DEVSPACE_OIDC_TENANT_CLAIM?.trim() || undefined,
        clockToleranceSeconds: parsePositiveInteger(
          env.DEVSPACE_OIDC_CLOCK_TOLERANCE_SECONDS,
          DEFAULT_OIDC_CLOCK_TOLERANCE_SECONDS,
          "DEVSPACE_OIDC_CLOCK_TOLERANCE_SECONDS",
        ),
      },
    };
  }

  return {
    ...common,
    mode,
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
  };
}

function parseDatabaseConfig(env: NodeJS.ProcessEnv, stateDir: string): DatabaseConfig {
  const provider = parseDatabaseProvider(env.DEVSPACE_DATABASE_PROVIDER);
  if (provider === "postgres") {
    return {
      provider,
      url: parseRequiredString(env.DEVSPACE_DATABASE_URL, "DEVSPACE_DATABASE_URL"),
      sslMode: parsePostgresSslMode(env.DEVSPACE_POSTGRES_SSL_MODE),
    };
  }

  return {
    provider,
    stateDir,
    filePath: join(stateDir, "devspace.sqlite"),
  };
}

function assertProductionConfig(config: Pick<ServerConfig, "deploymentMode" | "oauth" | "database">): void {
  if (config.deploymentMode !== "production") return;
  if (config.oauth.mode !== "oidc") {
    throw new Error("DEVSPACE_DEPLOYMENT_MODE=production requires DEVSPACE_AUTH_MODE=oidc.");
  }
  if (config.database.provider !== "postgres") {
    throw new Error("DEVSPACE_DEPLOYMENT_MODE=production requires DEVSPACE_DATABASE_PROVIDER=postgres.");
  }
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];
  const stateDir = resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir()));
  const config: ServerConfig = {
    host,
    port,
    deploymentMode: parseDeploymentMode(env.DEVSPACE_DEPLOYMENT_MODE),
    oauth: parseOAuthConfig(env, files.auth.ownerToken, stateDir),
    database: parseDatabaseConfig(env, stateDir),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    minimalTools: parseMinimalTools(env),
    toolNaming: parseToolNaming(env.DEVSPACE_TOOL_NAMING),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir,
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    workspaceSessionTtlSeconds: parseOptionalPositiveInteger(
      env.DEVSPACE_WORKSPACE_SESSION_TTL_SECONDS,
      "DEVSPACE_WORKSPACE_SESSION_TTL_SECONDS",
    ),
    workspaceSessionCleanupIntervalSeconds: parsePositiveInteger(
      env.DEVSPACE_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS,
      DEFAULT_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS,
      "DEVSPACE_WORKSPACE_SESSION_CLEANUP_INTERVAL_SECONDS",
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    logging: parseLoggingConfig(env),
  };

  assertProductionConfig(config);
  return config;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
