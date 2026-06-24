import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type {
  CloudWorkspaceCatalogRecord,
  CloudWorkspaceCatalogStore,
  ListCloudWorkspaceCatalogInput,
  RecordCloudWorkspaceCatalogInput,
} from "./cloud-workspace-catalog-store.js";
import { normalizeWorkspaceCatalogEntry } from "./cloud-workspace-catalog-store.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudWorkspaceCatalogQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudWorkspaceCatalogQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudWorkspaceCatalogQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudWorkspaceCatalogQuery,
) => Promise<PostgresCloudWorkspaceCatalogQueryResult<Row>>;

interface PgPoolResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface PgPool {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: QueryValue[],
  ): Promise<PgPoolResult<Row>>;
  end(): Promise<void>;
}

interface PgPoolConstructor {
  new (config: {
    connectionString: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    application_name: string;
    max: number;
  }): PgPool;
}

interface CloudWorkspaceCatalogRow {
  tenant_id: string;
  user_id: string;
  device_id: string;
  workspace_ref: string;
  display_name: string;
  root_label: string;
  capabilities: unknown;
  catalog_version: string | null;
  last_seen_at: string | Date;
}

export class PostgresCloudWorkspaceCatalogStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudWorkspaceCatalogStoreQueryError";
  }
}

export class PostgresCloudWorkspaceCatalogStore implements CloudWorkspaceCatalogStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresCloudWorkspaceCatalogQueryRunner,
  ) {}

  async recordCatalog(input: RecordCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const catalogVersion = normalizeOptionalCloudRoutingId(input.catalogVersion, "catalogVersion");
    const lastSeenAt = normalizeOptionalCloudRoutingId(input.now, "now") ?? new Date().toISOString();
    const records = input.workspaces.map((workspace) => normalizeWorkspaceCatalogEntry(workspace, {
      owner,
      deviceId,
      catalogVersion,
      lastSeenAt,
    }));

    await this.query({
      text: `
        delete from cloud_workspace_catalog
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
      `,
      values: [owner.tenantId, owner.userId, deviceId],
    });

    for (const record of records) {
      await this.query({
        text: `
          insert into cloud_workspace_catalog (
            tenant_id,
            user_id,
            device_id,
            workspace_ref,
            display_name,
            root_label,
            capabilities,
            catalog_version,
            last_seen_at
          ) values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7::jsonb,
            $8,
            $9::timestamptz
          )
        `,
        values: [
          owner.tenantId,
          owner.userId,
          deviceId,
          record.workspaceRef,
          record.displayName,
          record.rootLabel,
          JSON.stringify(record.capabilities),
          record.catalogVersion ?? null,
          record.lastSeenAt,
        ],
      });
    }

    return this.listWorkspaces({ owner, deviceId });
  }

  async listWorkspaces(input: ListCloudWorkspaceCatalogInput): Promise<CloudWorkspaceCatalogRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const result = await this.query<CloudWorkspaceCatalogRow>({
      text: `
        select
          tenant_id,
          user_id,
          device_id,
          workspace_ref,
          display_name,
          root_label,
          capabilities,
          catalog_version,
          last_seen_at
        from cloud_workspace_catalog
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
        order by display_name asc, workspace_ref asc
      `,
      values: [owner.tenantId, owner.userId, deviceId],
    });

    return result.rows.map(rowToCatalogRecord);
  }

  async clearDeviceCatalog(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<void> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    await this.query({
      text: `
        delete from cloud_workspace_catalog
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
      `,
      values: [owner.tenantId, owner.userId, deviceId],
    });
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudWorkspaceCatalogQuery,
  ): Promise<PostgresCloudWorkspaceCatalogQueryResult<Row>> {
    if (this.queryRunner) return this.queryRunner<Row>(query);

    const pool = await this.pool();
    const result = await pool.query<Row>(query.text, query.values);
    return {
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
    };
  }

  private pool(): Promise<PgPool> {
    this.poolPromise ??= createPool(this.config);
    return this.poolPromise;
  }
}

function rowToCatalogRecord(row: CloudWorkspaceCatalogRow): CloudWorkspaceCatalogRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    deviceId: row.device_id,
    workspaceRef: row.workspace_ref,
    displayName: row.display_name,
    rootLabel: row.root_label,
    capabilities: parseStringArray(row.capabilities),
    catalogVersion: row.catalog_version ?? undefined,
    lastSeenAt: toIsoString(row.last_seen_at),
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function createPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace",
    max: 10,
  });
}

async function importPgPool(): Promise<PgPoolConstructor> {
  const moduleName = "pg";

  try {
    const pg = (await import(moduleName)) as {
      Pool?: PgPoolConstructor;
      default?: { Pool?: PgPoolConstructor };
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error("The pg module did not export Pool.");
    return Pool;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Cannot find package 'pg'") || message.includes("Cannot find module 'pg'")) {
      throw new PostgresCloudWorkspaceCatalogStoreQueryError(
        "Postgres cloud workspace catalog mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
      );
    }
    throw error;
  }
}

function sslFor(config: PostgresDatabaseConfig): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}
