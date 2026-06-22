import { automationSourceTokenHash, generateAutomationSourceToken } from "./automation-token.js";
import type { ServerConfig } from "./config.js";
import { assertPostgresSchemaReady } from "./db/postgres-migrations.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import { createLocalIdentity, createOidcIdentity, type WorkspaceIdentity } from "./identity.js";
import {
  PostgresAutomationStore,
  type AutomationSource,
  type AutomationSourceKind,
  type AutomationSourceStatus,
  type CreateAutomationSourceInput,
  type JsonObject,
  type ListAutomationSourcesInput,
  type RotateAutomationSourceTokenInput,
} from "./postgres-automation-store.js";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MIN_SOURCE_TOKEN_LENGTH = 24;
const MAX_SOURCE_TOKEN_LENGTH = 4096;
const COMMON_FLAGS = new Set([
  "json",
  "local-owner",
  "tenant-id",
  "user-id",
  "oidc-issuer",
  "oidc-subject",
  "oidc-tenant",
  "oidc-client-id",
]);
const ACTION_FLAGS: Record<AutomationSourceAction, Set<string>> = {
  create: new Set(["id", "name", "kind", "status", "secret-ref", "config-json", "token"]),
  list: new Set(["kind", "status"]),
  "rotate-token": new Set(["id", "token"]),
};

type AutomationSourceAction = "create" | "list" | "rotate-token";

type FlagValue = string | true;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue>;
}

export interface AutomationSourceSummary {
  id: string;
  tenantId: string;
  userId: string;
  kind: AutomationSourceKind;
  name: string;
  status: AutomationSourceStatus;
  secretRef?: string;
  tokenPresent: boolean;
  config: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationSourceMutationOutput {
  source: AutomationSourceSummary;
  token: string;
}

export interface AutomationSourceListOutput {
  sources: AutomationSourceSummary[];
}

export interface AutomationSourceCliStore {
  createSource(input: CreateAutomationSourceInput): Promise<AutomationSource>;
  listSources(input: ListAutomationSourcesInput): Promise<AutomationSource[]>;
  rotateSourceToken(input: RotateAutomationSourceTokenInput): Promise<AutomationSource | undefined>;
  close?(): Promise<void>;
}

export interface AutomationSourceCliDependencies {
  createStore?: (config: PostgresDatabaseConfig) => AutomationSourceCliStore;
  assertSchemaReady?: (config: PostgresDatabaseConfig) => Promise<void>;
  generateToken?: () => string;
  write?: (line: string) => void;
}

export async function runAutomationCommand(
  args: string[],
  config: ServerConfig,
  dependencies: AutomationSourceCliDependencies = {},
): Promise<void> {
  const [area, action, ...rest] = args;
  if (area !== "source") throw new Error("Usage: devspace automation source <create|list|rotate-token> [...options]");
  if (!isAutomationSourceAction(action)) {
    throw new Error("Usage: devspace automation source <create|list|rotate-token> [...options]");
  }

  if (config.database.provider !== "postgres") {
    throw new Error("`devspace automation` commands require DEVSPACE_DATABASE_PROVIDER=postgres.");
  }

  const parsed = parseArgs(rest);
  const write = dependencies.write ?? ((line) => console.log(line));
  await (dependencies.assertSchemaReady ?? assertPostgresSchemaReady)(config.database);

  const store = (dependencies.createStore ?? ((database) => new PostgresAutomationStore(database)))(config.database);
  try {
    const result = await runAutomationSourceAction(action, parsed, config, store, dependencies);
    printAutomationSourceResult(action, result, parsed.flags.has("json"), write);
  } finally {
    await store.close?.();
  }
}

async function runAutomationSourceAction(
  action: AutomationSourceAction,
  parsed: ParsedArgs,
  config: ServerConfig,
  store: AutomationSourceCliStore,
  dependencies: AutomationSourceCliDependencies,
): Promise<AutomationSourceMutationOutput | AutomationSourceListOutput> {
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected automation source argument: ${parsed.positionals.join(" ")}`);
  }
  assertAllowedFlags(action, parsed.flags);

  switch (action) {
    case "create":
      return createAutomationSource(parsed, config, store, dependencies);
    case "list":
      return listAutomationSources(parsed, config, store);
    case "rotate-token":
      return rotateAutomationSourceToken(parsed, config, store, dependencies);
  }
}

async function createAutomationSource(
  parsed: ParsedArgs,
  config: ServerConfig,
  store: AutomationSourceCliStore,
  dependencies: AutomationSourceCliDependencies,
): Promise<AutomationSourceMutationOutput> {
  const owner = resolveOwner(config, parsed.flags);
  const id = requiredSourceId(parsed.flags, "id");
  const name = requiredBoundedString(parsed.flags, "name", 1, 200);
  const kind = optionalKind(parsed.flags) ?? "api_trigger";
  const status = optionalStatus(parsed.flags) ?? "enabled";
  const secretRef = optionalBoundedString(parsed.flags, "secret-ref", 1, 500);
  const token = normalizedSourceToken(optionalString(parsed.flags, "token") ?? generateToken(dependencies));
  const source = await store.createSource({
    owner,
    id,
    kind,
    name,
    status,
    secretRef,
    tokenHash: automationSourceTokenHash(token),
    config: optionalConfig(parsed.flags),
  });

  return {
    source: summarizeSource(source),
    token,
  };
}

async function listAutomationSources(
  parsed: ParsedArgs,
  config: ServerConfig,
  store: AutomationSourceCliStore,
): Promise<AutomationSourceListOutput> {
  const owner = resolveOwner(config, parsed.flags);
  const sources = await store.listSources({
    owner,
    kind: optionalKind(parsed.flags),
    status: optionalStatus(parsed.flags),
  });

  return { sources: sources.map(summarizeSource) };
}

async function rotateAutomationSourceToken(
  parsed: ParsedArgs,
  config: ServerConfig,
  store: AutomationSourceCliStore,
  dependencies: AutomationSourceCliDependencies,
): Promise<AutomationSourceMutationOutput> {
  const owner = resolveOwner(config, parsed.flags);
  const id = requiredSourceId(parsed.flags, "id");
  const token = normalizedSourceToken(optionalString(parsed.flags, "token") ?? generateToken(dependencies));
  const source = await store.rotateSourceToken({
    owner,
    id,
    tokenHash: automationSourceTokenHash(token),
  });
  if (!source) throw new Error(`Automation source not found for this owner: ${id}`);

  return {
    source: summarizeSource(source),
    token,
  };
}

function printAutomationSourceResult(
  action: AutomationSourceAction,
  result: AutomationSourceMutationOutput | AutomationSourceListOutput,
  json: boolean,
  write: (line: string) => void,
): void {
  if (json) {
    write(JSON.stringify(result, null, 2));
    return;
  }

  if ("sources" in result) {
    if (result.sources.length === 0) {
      write("No automation sources found.");
      return;
    }
    write("ID\tKind\tStatus\tToken\tName");
    for (const source of result.sources) {
      write([
        source.id,
        source.kind,
        source.status,
        source.tokenPresent ? "yes" : "no",
        source.name,
      ].join("\t"));
    }
    return;
  }

  write(`${action === "create" ? "Created" : "Rotated token for"} automation source: ${result.source.id}`);
  write(`Kind: ${result.source.kind}`);
  write(`Status: ${result.source.status}`);
  write(`Token: ${result.token}`);
  write("Store this token now; DevSpace only keeps its hash.");
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, FlagValue>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    if (!name) throw new Error(`Invalid automation option: ${arg}`);

    if (name === "json" || name === "local-owner") {
      flags.set(name, true);
      continue;
    }

    const inlineValue = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : undefined;
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (inlineValue === undefined) index += 1;
    flags.set(name, value);
  }

  return { positionals, flags };
}

function assertAllowedFlags(action: AutomationSourceAction, flags: Map<string, FlagValue>): void {
  const actionFlags = ACTION_FLAGS[action];
  for (const flag of flags.keys()) {
    if (!COMMON_FLAGS.has(flag) && !actionFlags.has(flag)) {
      throw new Error(`Unexpected automation source option for ${action}: --${flag}`);
    }
  }
}

function resolveOwner(config: ServerConfig, flags: Map<string, FlagValue>): WorkspaceIdentity {
  const hasExactOwner = flags.has("tenant-id") || flags.has("user-id");
  const hasOidcOwner =
    flags.has("oidc-issuer") ||
    flags.has("oidc-subject") ||
    flags.has("oidc-tenant") ||
    flags.has("oidc-client-id");
  const localOwner = flags.has("local-owner");

  if ([hasExactOwner, hasOidcOwner, localOwner].filter(Boolean).length > 1) {
    throw new Error("Use only one owner mode: --local-owner, --tenant-id/--user-id, or --oidc-issuer/--oidc-subject.");
  }

  if (hasExactOwner) {
    return {
      tenantId: requiredBoundedString(flags, "tenant-id", 1, 500),
      userId: requiredBoundedString(flags, "user-id", 1, 700),
    };
  }

  if (hasOidcOwner) {
    return createOidcIdentity({
      issuer: requiredBoundedString(flags, "oidc-issuer", 1, 500),
      subject: requiredBoundedString(flags, "oidc-subject", 1, 300),
      tenantExternalId: optionalBoundedString(flags, "oidc-tenant", 1, 300),
      clientId: optionalBoundedString(flags, "oidc-client-id", 1, 300),
      scopes: ["devspace"],
    });
  }

  if (config.deploymentMode === "production") {
    throw new Error(
      "Production automation source commands require an explicit owner: --tenant-id/--user-id or --oidc-issuer/--oidc-subject.",
    );
  }

  return createLocalIdentity(["devspace"], "automation-cli");
}

function optionalKind(flags: Map<string, FlagValue>): AutomationSourceKind | undefined {
  const value = optionalString(flags, "kind");
  if (value === undefined) return undefined;
  if (value === "api_trigger" || value === "github_webhook" || value === "runtime_hook") return value;
  throw new Error(`Invalid --kind: ${value}`);
}

function optionalStatus(flags: Map<string, FlagValue>): AutomationSourceStatus | undefined {
  const value = optionalString(flags, "status");
  if (value === undefined) return undefined;
  if (value === "enabled" || value === "disabled") return value;
  throw new Error(`Invalid --status: ${value}`);
}

function optionalConfig(flags: Map<string, FlagValue>): JsonObject {
  const value = optionalString(flags, "config-json");
  if (value === undefined) return {};
  const parsed = JSON.parse(value) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  throw new Error("--config-json must be a JSON object.");
}

function requiredSourceId(flags: Map<string, FlagValue>, name: string): string {
  const id = requiredBoundedString(flags, name, 1, 128);
  if (!SOURCE_ID_PATTERN.test(id)) {
    throw new Error(`--${name} must be 1-128 characters and contain only letters, numbers, '.', '_', ':', or '-'.`);
  }
  return id;
}

function requiredBoundedString(
  flags: Map<string, FlagValue>,
  name: string,
  minLength: number,
  maxLength: number,
): string {
  const value = optionalBoundedString(flags, name, minLength, maxLength);
  if (value === undefined) throw new Error(`Missing required option --${name}`);
  return value;
}

function optionalBoundedString(
  flags: Map<string, FlagValue>,
  name: string,
  minLength: number,
  maxLength: number,
): string | undefined {
  const value = optionalString(flags, name);
  if (value === undefined) return undefined;
  if (value.length < minLength || value.length > maxLength) {
    throw new Error(`--${name} must be ${minLength}-${maxLength} characters.`);
  }
  return value;
}

function optionalString(flags: Map<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} requires a value.`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedSourceToken(value: string): string {
  const token = value.trim();
  if (token.length < MIN_SOURCE_TOKEN_LENGTH || token.length > MAX_SOURCE_TOKEN_LENGTH) {
    throw new Error(`Automation source token must be ${MIN_SOURCE_TOKEN_LENGTH}-${MAX_SOURCE_TOKEN_LENGTH} characters.`);
  }
  if (/\s/.test(token)) throw new Error("Automation source token must not contain whitespace.");
  return token;
}

function generateToken(dependencies: AutomationSourceCliDependencies): string {
  return dependencies.generateToken?.() ?? generateAutomationSourceToken();
}

function summarizeSource(source: AutomationSource): AutomationSourceSummary {
  return {
    id: source.id,
    tenantId: source.tenantId,
    userId: source.userId,
    kind: source.kind,
    name: source.name,
    status: source.status,
    ...(source.secretRef ? { secretRef: source.secretRef } : {}),
    tokenPresent: Boolean(source.tokenHash),
    config: source.config,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function isAutomationSourceAction(value: string | undefined): value is AutomationSourceAction {
  return value === "create" || value === "list" || value === "rotate-token";
}
