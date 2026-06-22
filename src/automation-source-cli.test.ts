import assert from "node:assert/strict";
import { runAutomationCommand, type AutomationSourceCliStore } from "./automation-source-cli.js";
import { automationSourceTokenHash } from "./automation-token.js";
import type { ServerConfig } from "./config.js";
import type { WorkspaceIdentity } from "./identity.js";
import type {
  AutomationSource,
  CreateAutomationSourceInput,
  ListAutomationSourcesInput,
  RotateAutomationSourceTokenInput,
} from "./postgres-automation-store.js";

const localConfig = configFor("local");
const productionConfig = configFor("production");

{
  const store = new FakeAutomationSourceStore();
  const writes: string[] = [];
  let schemaChecked = false;

  await runAutomationCommand(
    [
      "source",
      "create",
      "--id",
      "manual-smoke",
      "--name",
      "Manual Smoke",
      "--secret-ref",
      "secret:automation/manual-smoke",
      "--config-json",
      '{"triggerId":"manual-smoke"}',
      "--json",
    ],
    localConfig,
    {
      createStore: () => store,
      assertSchemaReady: async () => {
        schemaChecked = true;
      },
      generateToken: () => "dsp_auto_test_token_12345678901234567890",
      write: (line) => writes.push(line),
    },
  );

  assert.equal(schemaChecked, true);
  assert.equal(store.closed, true);
  assert.equal(store.sources.length, 1);
  assert.equal(store.sources[0]?.tenantId, "local");
  assert.equal(store.sources[0]?.userId, "owner");
  assert.equal(store.sources[0]?.tokenHash, automationSourceTokenHash("dsp_auto_test_token_12345678901234567890"));

  const output = JSON.parse(writes.join("\n")) as {
    source: { id: string; tokenPresent: boolean; tokenHash?: string; config: Record<string, unknown> };
    token: string;
  };
  assert.equal(output.source.id, "manual-smoke");
  assert.equal(output.source.tokenPresent, true);
  assert.equal(output.source.tokenHash, undefined);
  assert.deepEqual(output.source.config, { triggerId: "manual-smoke" });
  assert.equal(output.token, "dsp_auto_test_token_12345678901234567890");
}

{
  const store = new FakeAutomationSourceStore();
  await store.createSource({
    owner: { tenantId: "local", userId: "owner" },
    id: "manual-smoke",
    kind: "api_trigger",
    name: "Manual Smoke",
    tokenHash: automationSourceTokenHash("dsp_auto_existing_token_1234567890"),
  });
  await store.createSource({
    owner: { tenantId: "local", userId: "owner" },
    id: "disabled-hook",
    kind: "runtime_hook",
    name: "Disabled Hook",
    status: "disabled",
  });
  const writes: string[] = [];

  await runAutomationCommand(
    ["source", "list", "--kind", "api_trigger", "--json"],
    localConfig,
    {
      createStore: () => store,
      assertSchemaReady: async () => {},
      write: (line) => writes.push(line),
    },
  );

  const output = JSON.parse(writes.join("\n")) as {
    sources: Array<{ id: string; tokenPresent: boolean; token?: string; tokenHash?: string }>;
  };
  assert.deepEqual(output.sources.map((source) => source.id), ["manual-smoke"]);
  assert.equal(output.sources[0]?.tokenPresent, true);
  assert.equal(output.sources[0]?.token, undefined);
  assert.equal(output.sources[0]?.tokenHash, undefined);
}

{
  const store = new FakeAutomationSourceStore();
  await store.createSource({
    owner: { tenantId: "local", userId: "owner" },
    id: "manual-smoke",
    kind: "api_trigger",
    name: "Manual Smoke",
    tokenHash: automationSourceTokenHash("dsp_auto_existing_token_1234567890"),
  });
  const writes: string[] = [];

  await runAutomationCommand(
    ["source", "rotate-token", "--id", "manual-smoke", "--json"],
    localConfig,
    {
      createStore: () => store,
      assertSchemaReady: async () => {},
      generateToken: () => "dsp_auto_rotated_token_123456789012345678",
      write: (line) => writes.push(line),
    },
  );

  const output = JSON.parse(writes.join("\n")) as {
    source: { id: string; tokenPresent: boolean; tokenHash?: string };
    token: string;
  };
  assert.equal(output.source.id, "manual-smoke");
  assert.equal(output.source.tokenPresent, true);
  assert.equal(output.source.tokenHash, undefined);
  assert.equal(output.token, "dsp_auto_rotated_token_123456789012345678");
  assert.equal(store.sources[0]?.tokenHash, automationSourceTokenHash("dsp_auto_rotated_token_123456789012345678"));
}

await assert.rejects(
  () =>
    runAutomationCommand(
      ["source", "create", "--id", "prod-source", "--name", "Prod Source"],
      productionConfig,
      {
        createStore: () => new FakeAutomationSourceStore(),
        assertSchemaReady: async () => {},
        generateToken: () => "dsp_auto_prod_token_12345678901234567890",
        write: () => {},
      },
    ),
  /Production automation source commands require an explicit owner/,
);

{
  const store = new FakeAutomationSourceStore();
  await runAutomationCommand(
    [
      "source",
      "create",
      "--id",
      "prod-source",
      "--name",
      "Prod Source",
      "--oidc-issuer",
      "https://auth.example.com",
      "--oidc-tenant",
      "tenant-a",
      "--oidc-subject",
      "alice",
      "--json",
    ],
    productionConfig,
    {
      createStore: () => store,
      assertSchemaReady: async () => {},
      generateToken: () => "dsp_auto_prod_token_12345678901234567890",
      write: () => {},
    },
  );

  assert.equal(store.sources[0]?.tenantId, "https://auth.example.com#tenant-a");
  assert.equal(store.sources[0]?.userId, "https://auth.example.com#tenant-a#alice");
}

class FakeAutomationSourceStore implements AutomationSourceCliStore {
  readonly sources: AutomationSource[] = [];
  closed = false;

  async createSource(input: CreateAutomationSourceInput): Promise<AutomationSource> {
    const source: AutomationSource = {
      id: input.id,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
      kind: input.kind,
      name: input.name,
      status: input.status ?? "enabled",
      ...(input.secretRef ? { secretRef: input.secretRef } : {}),
      ...(input.tokenHash ? { tokenHash: input.tokenHash } : {}),
      config: input.config ?? {},
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    };
    this.sources.unshift(source);
    return source;
  }

  async listSources(input: ListAutomationSourcesInput): Promise<AutomationSource[]> {
    return this.sources.filter(
      (source) =>
        ownerMatches(source, input.owner) &&
        (!input.kind || source.kind === input.kind) &&
        (!input.status || source.status === input.status),
    );
  }

  async rotateSourceToken(input: RotateAutomationSourceTokenInput): Promise<AutomationSource | undefined> {
    const source = this.sources.find((candidate) => candidate.id === input.id && ownerMatches(candidate, input.owner));
    if (!source) return undefined;
    source.tokenHash = input.tokenHash;
    source.updatedAt = "2026-06-22T00:00:01.000Z";
    return source;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function ownerMatches(source: AutomationSource, owner: WorkspaceIdentity): boolean {
  return source.tenantId === owner.tenantId && source.userId === owner.userId;
}

function configFor(deploymentMode: ServerConfig["deploymentMode"]): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 7676,
    deploymentMode,
    oauth: {
      mode: deploymentMode === "production" ? "oidc" : "owner-token",
      ownerToken: deploymentMode === "production" ? undefined : "owner-token-that-is-long-enough",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 3600,
      scopes: ["devspace"],
      allowedRedirectHosts: ["localhost"],
      oidc: deploymentMode === "production"
        ? {
            issuer: "https://auth.example.com",
            audience: "devspace",
            jwksUri: "https://auth.example.com/.well-known/jwks.json",
            userClaim: "sub",
            clockToleranceSeconds: 30,
          }
        : undefined,
    },
    database: {
      provider: "postgres",
      url: "postgres://devspace:secret@db.example.com:5432/devspace",
      sslMode: "disable",
    },
    allowedRoots: ["/workspace"],
    allowedHosts: ["localhost"],
    publicBaseUrl: "http://127.0.0.1:7676",
    minimalTools: true,
    toolNaming: "short",
    widgets: "full",
    stateDir: "/tmp/devspace-state",
    worktreeRoot: "/tmp/devspace-worktrees",
    workspaceSessionTtlSeconds: null,
    workspaceSessionCleanupIntervalSeconds: 3600,
    skillsEnabled: true,
    skillPaths: [],
    agentDir: "/tmp/devspace-agent",
    logging: {
      level: "info",
      format: "json",
      requests: true,
      assets: false,
      toolCalls: true,
      shellCommands: false,
      trustProxy: false,
    },
  };
}
