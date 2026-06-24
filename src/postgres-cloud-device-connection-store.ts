import {
  normalizeCloudRouteCapabilities,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type {
  CloudDeviceConnectionRecord,
  CloudDeviceConnectionStatus,
  CloudDeviceConnectionStore,
  ListCloudDeviceConnectionsInput,
  RecordCloudDeviceConnectedInput,
  RecordCloudDeviceDisconnectedInput,
  RecordCloudDeviceHeartbeatInput,
} from "./cloud-device-connection-store.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudDeviceConnectionQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudDeviceConnectionQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudDeviceConnectionQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudDeviceConnectionQuery,
) => Promise<PostgresCloudDeviceConnectionQueryResult<Row>>;

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

interface CloudDeviceConnectionRow {
  tenant_id: string;
  user_id: string;
  device_id: string;
  connection_id: string;
  status: string;
  capabilities: unknown;
  desktop_instance_id: string | null;
  agent_version: string | null;
  connected_at: string | Date;
  last_heartbeat_at: string | Date;
  disconnected_at: string | Date | null;
}

export class PostgresCloudDeviceConnectionStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudDeviceConnectionStoreQueryError";
  }
}

export class PostgresCloudDeviceConnectionStore implements CloudDeviceConnectionStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresCloudDeviceConnectionQueryRunner,
  ) {}

  async recordConnected(input: RecordCloudDeviceConnectedInput): Promise<CloudDeviceConnectionRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const now = routeNow(input.now);
    const result = await this.query<CloudDeviceConnectionRow>({
      text: `
        insert into cloud_device_connections (
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          'online',
          $5::jsonb,
          $6,
          $7,
          $8::timestamptz,
          $9::timestamptz,
          null
        )
        on conflict (tenant_id, user_id, device_id) do update set
          connection_id = excluded.connection_id,
          status = 'online',
          capabilities = excluded.capabilities,
          desktop_instance_id = excluded.desktop_instance_id,
          agent_version = excluded.agent_version,
          last_heartbeat_at = excluded.last_heartbeat_at,
          disconnected_at = null
        returning
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
      `,
      values: [
        owner.tenantId,
        owner.userId,
        deviceId,
        connectionId,
        JSON.stringify(normalizeCloudRouteCapabilities(input.capabilities)),
        normalizeOptionalCloudRoutingId(input.desktopInstanceId, "desktopInstanceId") ?? null,
        normalizeOptionalCloudRoutingId(input.agentVersion, "agentVersion") ?? null,
        now,
        now,
      ],
    });

    return rowToConnection(requiredRow(result.rows[0], "cloud device connection upsert failed"));
  }

  async recordHeartbeat(input: RecordCloudDeviceHeartbeatInput): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const now = routeNow(input.now);
    const result = await this.query<CloudDeviceConnectionRow>({
      text: `
        update cloud_device_connections
        set status = 'online',
            last_heartbeat_at = $5::timestamptz,
            disconnected_at = null
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
          and connection_id = $4
        returning
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
      `,
      values: [owner.tenantId, owner.userId, deviceId, connectionId, now],
    });

    const row = result.rows[0];
    return row ? rowToConnection(row) : undefined;
  }

  async recordDisconnected(input: RecordCloudDeviceDisconnectedInput): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const connectionId = normalizeRequiredCloudRoutingId(input.connectionId, "connectionId");
    const now = routeNow(input.now);
    const result = await this.query<CloudDeviceConnectionRow>({
      text: `
        update cloud_device_connections
        set status = 'offline',
            last_heartbeat_at = $5::timestamptz,
            disconnected_at = $6::timestamptz
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
          and connection_id = $4
        returning
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
      `,
      values: [owner.tenantId, owner.userId, deviceId, connectionId, now, now],
    });

    const row = result.rows[0];
    return row ? rowToConnection(row) : undefined;
  }

  async getConnection(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<CloudDeviceConnectionRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    const result = await this.query<CloudDeviceConnectionRow>({
      text: `
        select
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
        from cloud_device_connections
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
        limit 1
      `,
      values: [owner.tenantId, owner.userId, deviceId],
    });

    const row = result.rows[0];
    return row ? rowToConnection(row) : undefined;
  }

  async listConnections(input: ListCloudDeviceConnectionsInput): Promise<CloudDeviceConnectionRecord[]> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const status = input.status ?? null;
    const result = await this.query<CloudDeviceConnectionRow>({
      text: `
        select
          tenant_id,
          user_id,
          device_id,
          connection_id,
          status,
          capabilities,
          desktop_instance_id,
          agent_version,
          connected_at,
          last_heartbeat_at,
          disconnected_at
        from cloud_device_connections
        where tenant_id = $1
          and user_id = $2
          and ($3::text is null or status = $3)
        order by last_heartbeat_at desc
      `,
      values: [owner.tenantId, owner.userId, status],
    });

    return result.rows.map(rowToConnection);
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudDeviceConnectionQuery,
  ): Promise<PostgresCloudDeviceConnectionQueryResult<Row>> {
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

function rowToConnection(row: CloudDeviceConnectionRow): CloudDeviceConnectionRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    deviceId: row.device_id,
    connectionId: row.connection_id,
    status: connectionStatus(row.status),
    capabilities: parseStringArray(row.capabilities),
    desktopInstanceId: row.desktop_instance_id ?? undefined,
    agentVersion: row.agent_version ?? undefined,
    connectedAt: toIsoString(row.connected_at),
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
    disconnectedAt: optionalIsoString(row.disconnected_at),
  };
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresCloudDeviceConnectionStoreQueryError(message);
  return row;
}

function routeNow(now: string | undefined): string {
  return normalizeOptionalCloudRoutingId(now, "now") ?? new Date().toISOString();
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function connectionStatus(value: string): CloudDeviceConnectionStatus {
  if (value === "online" || value === "offline") return value;
  return "offline";
}

function optionalIsoString(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  return toIsoString(value);
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
      throw new PostgresCloudDeviceConnectionStoreQueryError(
        "Postgres cloud device connection mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
