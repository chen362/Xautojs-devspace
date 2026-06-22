import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "short" }).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "legacy" }).toolNaming, "legacy");
assert.equal(loadConfig(baseEnv).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).minimalTools, true);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "invalid" }),
  /Invalid DEVSPACE_TOOL_NAMING: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).deploymentMode, "local");
assert.equal(loadConfig(baseEnv).oauth.mode, "owner-token");
assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);
const sqliteDatabase = loadConfig(baseEnv).database;
assert.equal(sqliteDatabase.provider, "sqlite");
assert.equal(sqliteDatabase.provider === "sqlite" ? sqliteDatabase.filePath.endsWith("devspace.sqlite") : false, true);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

const oidcEnv = {
  ...baseEnv,
  DEVSPACE_AUTH_MODE: "oidc",
  DEVSPACE_OIDC_ISSUER: "https://auth.example.com/",
  DEVSPACE_OIDC_AUDIENCE: "https://mcp.devspace.example.com",
  DEVSPACE_OIDC_SCOPES: "devspace:workspace:open,devspace:files:read",
};
const oidcConfig = loadConfig(oidcEnv);
assert.equal(oidcConfig.oauth.mode, "oidc");
assert.equal(oidcConfig.oauth.ownerToken, undefined);
assert.equal(oidcConfig.oauth.oidc?.issuer, "https://auth.example.com");
assert.equal(oidcConfig.oauth.oidc?.audience, "https://mcp.devspace.example.com");
assert.equal(oidcConfig.oauth.oidc?.jwksUri, "https://auth.example.com/.well-known/jwks.json");
assert.equal(oidcConfig.oauth.oidc?.userClaim, "sub");
assert.equal(oidcConfig.oauth.oidc?.clockToleranceSeconds, 30);
assert.deepEqual(oidcConfig.oauth.scopes, ["devspace:workspace:open", "devspace:files:read"]);

const oidcCustomConfig = loadConfig({
  ...oidcEnv,
  DEVSPACE_OIDC_JWKS_URI: "https://keys.example.com/jwks",
  DEVSPACE_OIDC_USER_CLAIM: "email",
  DEVSPACE_OIDC_TENANT_CLAIM: "org_id",
  DEVSPACE_OIDC_CLOCK_TOLERANCE_SECONDS: "45",
});
assert.equal(oidcCustomConfig.oauth.oidc?.jwksUri, "https://keys.example.com/jwks");
assert.equal(oidcCustomConfig.oauth.oidc?.userClaim, "email");
assert.equal(oidcCustomConfig.oauth.oidc?.tenantClaim, "org_id");
assert.equal(oidcCustomConfig.oauth.oidc?.clockToleranceSeconds, 45);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_AUTH_MODE: "invalid" }),
  /Invalid DEVSPACE_AUTH_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_AUTH_MODE: "oidc" }),
  /DEVSPACE_OIDC_ISSUER is required/,
);
assert.throws(
  () => loadConfig({ ...oidcEnv, DEVSPACE_OIDC_AUDIENCE: "" }),
  /DEVSPACE_OIDC_AUDIENCE is required/,
);

const postgresConfig = loadConfig({
  ...baseEnv,
  DEVSPACE_DATABASE_PROVIDER: "postgres",
  DEVSPACE_DATABASE_URL: "postgres://devspace:secret@db.example.com:5432/devspace",
  DEVSPACE_POSTGRES_SSL_MODE: "require",
});
assert.equal(postgresConfig.database.provider, "postgres");
assert.equal(postgresConfig.database.provider === "postgres" ? postgresConfig.database.url : undefined, "postgres://devspace:secret@db.example.com:5432/devspace");
assert.equal(postgresConfig.database.provider === "postgres" ? postgresConfig.database.sslMode : undefined, "require");

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_DATABASE_PROVIDER: "mysql" }),
  /Invalid DEVSPACE_DATABASE_PROVIDER: mysql/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_DATABASE_PROVIDER: "postgres" }),
  /DEVSPACE_DATABASE_URL is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_DATABASE_PROVIDER: "postgres", DEVSPACE_DATABASE_URL: "postgres://db", DEVSPACE_POSTGRES_SSL_MODE: "always" }),
  /Invalid DEVSPACE_POSTGRES_SSL_MODE: always/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_DEPLOYMENT_MODE: "staging" }),
  /Invalid DEVSPACE_DEPLOYMENT_MODE: staging/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_DEPLOYMENT_MODE: "production" }),
  /DEVSPACE_DEPLOYMENT_MODE=production requires DEVSPACE_AUTH_MODE=oidc/,
);
assert.throws(
  () => loadConfig({ ...oidcEnv, DEVSPACE_DEPLOYMENT_MODE: "production" }),
  /DEVSPACE_DEPLOYMENT_MODE=production requires DEVSPACE_DATABASE_PROVIDER=postgres/,
);
assert.equal(
  loadConfig({
    ...oidcEnv,
    DEVSPACE_DEPLOYMENT_MODE: "production",
    DEVSPACE_DATABASE_PROVIDER: "postgres",
    DEVSPACE_DATABASE_URL: "postgres://devspace:secret@db.example.com:5432/devspace",
  }).deploymentMode,
  "production",
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
