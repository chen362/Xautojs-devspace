#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { registerAutomationApiRoutes } from "./automation-api.js";
import { runAutomationCommand } from "./automation-source-cli.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { postgresConnectionSummary } from "./db/postgres.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { PostgresMigrationStatusJson } from "./db/postgres-migrations.js";
import { registerGithubWebhookRoutes } from "./github-webhook-api.js";
import { registerNativeAgentApiRoutes } from "./native-agent-api.js";
import { runNativeAgentCommand } from "./native-agent-cli.js";
import { buildReadinessReport } from "./readiness.js";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";

type Command = "serve" | "init" | "doctor" | "config" | "db" | "automation" | "agent" | "help";
type DbCommand = "migrate" | "status";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

interface SqliteMemoryDatabaseConstructor {
  new (filename: string): { close(): void };
}

interface DoctorReport {
  ok: boolean;
  configDir: string;
  configFile: string | "missing";
  authFile: string | "missing";
  runtime: {
    node: string;
    nodeRange: string;
    nodeStatus: string;
    nodeSupported: boolean;
    nodeAbi: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  tools: {
    git: string;
    bashShell: string;
    sqliteNative: string;
  };
  config: DoctorConfigReport;
  postgresSchema?: DoctorPostgresSchemaReport;
}

type DoctorConfigReport =
  | {
      status: "ok";
      deploymentMode: ServerConfig["deploymentMode"];
      authMode: ServerConfig["oauth"]["mode"];
      database: DoctorDatabaseReport;
      localMcpUrl: string;
      publicMcpUrl: string;
      allowedRoots: string[];
      allowedHosts: string[];
      logging: ServerConfig["logging"];
    }
  | {
      status: "error";
      error: string;
    };

type DoctorDatabaseReport =
  | {
      provider: "sqlite";
      stateDir: string;
      filePath: string;
    }
  | ReturnType<typeof postgresConnectionSummary>;

type DoctorPostgresSchemaReport =
  | ({ state: "ready" | "missing" | "pending" | "modified" } & PostgresMigrationStatusJson)
  | {
      state: "error";
      ready: false;
      error: string;
    };

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor(args);
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "db":
      await runDbCommand(args);
      return;
    case "automation":
      await runAutomationCommand(args, loadConfig());
      return;
    case "agent":
      await runNativeAgentCommand(args, loadConfig());
      return;
    case "help":
      printHelp();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "init" ||
    command === "doctor" ||
    command === "config" ||
    command === "db" ||
    command === "automation" ||
    command === "agent"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const config = loadConfig();
  if (config.database.provider === "sqlite") {
    const sqliteStatus = checkSqliteNative();
    if (sqliteStatus !== "ok") {
      throw new Error(
        [
          "better-sqlite3 could not load for this Node runtime.",
          sqliteStatus,
          "",
          "Try reinstalling or rebuilding dependencies under the active Node version:",
          "  npm rebuild better-sqlite3",
        ].join("\n"),
      );
    }
  } else {
    const { assertPostgresSchemaReady } = await import("./db/postgres-migrations.js");
    await assertPostgresSchemaReady(config.database);
  }

  const { createServer } = await import("./server.js");
  const runningServer = createServer(config);
  const { app } = runningServer;
  const automationRoutes = registerAutomationApiRoutes(app, config);
  const githubWebhookRoutes = registerGithubWebhookRoutes(app, config);
  const nativeAgentRoutes = registerNativeAgentApiRoutes(app, config);
  app.get("/readyz", async (_req, res) => {
    const report = await buildReadinessReport(config);
    res.status(report.ok ? 200 : 503).json(report);
  });

  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log(`auth: ${config.oauth.mode}`);
    console.log(`database: ${config.database.provider}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });

  const shutdown = () => {
    httpServer.close(() => {
      void Promise.all([
        automationRoutes.close(),
        githubWebhookRoutes.close(),
        nativeAgentRoutes.close(),
        runningServer.close(),
      ]).finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runDoctor(args: string[]): Promise<void> {
  const json = parseJsonOnlyArgs(args, "devspace doctor");
  const report = await buildDoctorReport();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printDoctorReport(report);
}

async function buildDoctorReport(): Promise<DoctorReport> {
  const files = loadDevspaceFiles();
  let config: ServerConfig | undefined;
  let configError: unknown;

  try {
    config = loadConfig();
  } catch (error) {
    configError = error;
  }

  const sqliteNative = sqliteNativeStatus(config);
  const report: DoctorReport = {
    ok: false,
    configDir: files.dir,
    configFile: files.configExists ? files.configPath : "missing",
    authFile: files.authExists ? files.authPath : "missing",
    runtime: {
      node: process.version,
      nodeRange: SUPPORTED_NODE_RANGE,
      nodeStatus: nodeVersionStatus(),
      nodeSupported: isNodeSupported(),
      nodeAbi: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
    },
    tools: {
      git: checkGitAvailable(),
      bashShell: checkBashShell(),
      sqliteNative,
    },
    config: config
      ? {
          status: "ok",
          deploymentMode: config.deploymentMode,
          authMode: config.oauth.mode,
          database: doctorDatabaseReport(config),
          localMcpUrl: `http://${config.host}:${config.port}/mcp`,
          publicMcpUrl: new URL("/mcp", config.publicBaseUrl).toString(),
          allowedRoots: config.allowedRoots,
          allowedHosts: config.allowedHosts,
          logging: config.logging,
        }
      : {
          status: "error",
          error: configError instanceof Error ? configError.message : String(configError),
        },
  };

  if (config?.database.provider === "postgres") {
    report.postgresSchema = await getDoctorPostgresSchemaReport(config.database);
  }

  report.ok =
    report.config.status === "ok"
    && report.runtime.nodeSupported
    && sqliteNativeIsOk(sqliteNative)
    && (report.postgresSchema ? report.postgresSchema.ready : true);

  return report;
}

function printDoctorReport(report: DoctorReport): void {
  console.log(`Config dir: ${report.configDir}`);
  console.log(`Config file: ${report.configFile}`);
  console.log(`Auth file: ${report.authFile}`);
  console.log(`Node: ${report.runtime.node} (${report.runtime.nodeStatus})`);
  console.log(`Node ABI: ${report.runtime.nodeAbi}`);
  console.log(`Platform: ${report.runtime.platform} ${report.runtime.arch}`);
  console.log(`Git: ${report.tools.git}`);
  console.log(`Bash shell: ${report.tools.bashShell}`);
  console.log(`SQLite native dependency: ${report.tools.sqliteNative}`);

  if (report.config.status !== "ok") {
    console.log(`Config status: ${report.config.error}`);
    return;
  }

  console.log(`Database provider: ${report.config.database.provider}`);
  if (report.config.database.provider === "postgres") {
    console.log(`Postgres URL: ${report.config.database.url}`);
    console.log(`Postgres SSL mode: ${report.config.database.sslMode}`);
  }
  if (report.postgresSchema) {
    console.log(`Postgres schema: ${formatPostgresSchemaLine(report.postgresSchema)}`);
  }
  console.log(`Local MCP URL: ${report.config.localMcpUrl}`);
  console.log(`Public MCP URL: ${report.config.publicMcpUrl}`);
  console.log(`Allowed roots: ${report.config.allowedRoots.join(", ")}`);
  console.log(`Allowed hosts: ${report.config.allowedHosts.join(", ")}`);
}

async function getDoctorPostgresSchemaReport(
  config: PostgresDatabaseConfig,
): Promise<DoctorPostgresSchemaReport> {
  try {
    const {
      getPostgresMigrationStatus,
      postgresSchemaState,
      toPostgresMigrationStatusJson,
    } = await import("./db/postgres-migrations.js");
    const status = await getPostgresMigrationStatus(config);
    const json = toPostgresMigrationStatusJson(status);
    return {
      ...json,
      state: postgresSchemaState(status),
    };
  } catch (error) {
    return {
      state: "error",
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function doctorDatabaseReport(config: ServerConfig): DoctorDatabaseReport {
  if (config.database.provider === "postgres") return postgresConnectionSummary(config.database);
  return {
    provider: "sqlite",
    stateDir: config.database.stateDir,
    filePath: config.database.filePath,
  };
}

function formatPostgresSchemaLine(schema: DoctorPostgresSchemaReport): string {
  if (schema.state === "error") return `error (${schema.error})`;
  return [
    schema.state,
    `table=${schema.tableExists ? schema.tableName : "missing"}`,
    `applied=${schema.appliedCount}`,
    `pending=${schema.pendingCount}`,
    `modified=${schema.modifiedCount}`,
  ].join(" ");
}

async function runDbCommand(args: string[]): Promise<void> {
  const { command, json } = parseDbCommandArgs(args);

  const config = loadConfig();
  if (config.database.provider !== "postgres") {
    throw new Error("`devspace db` commands require DEVSPACE_DATABASE_PROVIDER=postgres.");
  }

  const {
    formatPostgresMigrationResult,
    formatPostgresMigrationStatus,
    getPostgresMigrationStatus,
    migratePostgresDatabase,
    toPostgresMigrationStatusJson,
  } = await import("./db/postgres-migrations.js");

  if (command === "status") {
    const status = await getPostgresMigrationStatus(config.database);
    if (json) {
      console.log(JSON.stringify(toPostgresMigrationStatusJson(status), null, 2));
      return;
    }
    console.log(formatPostgresMigrationStatus(status));
    return;
  }

  const result = await migratePostgresDatabase(config.database);
  if (json) {
    console.log(JSON.stringify({
      applied: result.applied.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      })),
      status: toPostgresMigrationStatusJson(result.status),
    }, null, 2));
    return;
  }
  console.log(formatPostgresMigrationResult(result));
  console.log("");
  console.log(formatPostgresMigrationStatus(result.status));
}

function parseDbCommandArgs(args: string[]): { command: DbCommand; json: boolean } {
  const positional: string[] = [];
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unexpected devspace db option: ${arg}`);
    }
    positional.push(arg);
  }

  const [rawSubcommand, ...rest] = positional;
  if (rest.length > 0) {
    throw new Error(`Unexpected devspace db argument: ${rest.join(" ")}`);
  }

  return { command: normalizeDbCommand(rawSubcommand), json };
}

function parseJsonOnlyArgs(args: string[], command: string): boolean {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unexpected ${command} argument: ${arg}`);
  }
  return json;
}

function normalizeDbCommand(command: string | undefined): DbCommand {
  if (!command || command === "status") return "status";
  if (command === "migrate") return "migrate";
  throw new Error(`Unknown db command: ${command}`);
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and dependency status",
      "  devspace doctor --json   Show doctor status as JSON",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace db status       Show Postgres migration status",
      "  devspace db status --json",
      "  devspace db migrate      Apply pending Postgres migrations",
      "  devspace db migrate --json",
      "  devspace automation source create --id <id> --name <name>",
      "  devspace automation source list",
      "  devspace automation source rotate-token --id <id>",
      "  devspace agent workflows",
      "  devspace agent dispatch-once --workspace-root <path>",
      "  devspace agent list",
      "  devspace agent events --id <agentRunId>",
      "  devspace agent cancel --id <agentRunId>",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (isNodeSupported()) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function isNodeSupported(): boolean {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE);
}

function nodeVersionStatus(): string {
  return isNodeSupported()
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function sqliteNativeStatus(config: ReturnType<typeof loadConfig> | undefined): string {
  if (config?.database.provider === "postgres") return "skipped (postgres mode)";
  return checkSqliteNative();
}

function sqliteNativeIsOk(status: string): boolean {
  return status === "ok" || status.startsWith("skipped ");
}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as SqliteMemoryDatabaseConstructor;
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
