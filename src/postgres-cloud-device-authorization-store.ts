import type {
  CloudDeviceAuthorizationRecord,
  CloudDeviceAuthorizationStatus,
  CloudDeviceAuthorizationStore,
} from "./cloud-device-code-auth.js";
import {
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type { PostgresDatabaseConfig } from "./db/types.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudDeviceAuthorizationQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudDeviceAuthorizationQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudDeviceAuthorizationQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudDeviceAuthorizationQuery,
) => Promise<PostgresCloudDeviceAuthorizationQueryResult<Row>>;

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

interface CloudDeviceAuthorizationRow {
  device_code: string;
  user_code: string;
  status: string;
  client_name: string | null;
  device_id: string | null;
  desktop_instance_id: string | null;
  tenant_id: string | null;
  user_id: string | null;
  created_at: string | Date;
  expires_at: string | Date;
  interval_seconds: number;
  approved_at: string | Date | null;
  denied_at: string | Date | null;
  last_polled_at: string | Date | null;
}

export class PostgresCloudDeviceAuthorizationStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudDeviceAuthorizationStoreQueryError";
  }
}

export class PostgresCloudDeviceAuthorizationStore implements CloudDeviceAuthorizationStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresCloudDeviceAuthorizationQueryRunner,
  ) {}

  async create(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord> {
    const record = normalizeRecord(input);
    const result = await this.query<CloudDeviceAuthorizationRow>({
      text: `
        insert into cloud_device_authorizations (
          device_code,
          user_code,
          status,
          client_name,
          device_id,
          desktop_instance_id,
          tenant_id,
          user_id,
          created_at,
          expires_at,
          interval_seconds,
          approved_at,
          denied_at,
          last_polled_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::timestamptz,
          $10::timestamptz,
          $11,
          $12::timestamptz,
          $13::timestamptz,
          $14::timestamptz
        )
        returning ${rowColumns()}
      `,
      values: valuesForRecord(record),
    });

    return rowToRecord(requiredRow(result.rows[0], "cloud device authorization insert failed"));
  }

  async getByDeviceCode(deviceCodeInput: string): Promise<CloudDeviceAuthorizationRecord | undefined> {
    const deviceCode = normalizeRequiredCloudRoutingId(deviceCodeInput, "deviceCode");
    const result = await this.query<CloudDeviceAuthorizationRow>({
      text: `
        select ${rowColumns()}
        from cloud_device_authorizations
        where device_code = $1
        limit 1
      `,
      values: [deviceCode],
    });

    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async getByUserCode(userCodeInput: string): Promise<CloudDeviceAuthorizationRecord | undefined> {
    const userCode = normalizeRequiredCloudRoutingId(userCodeInput, "userCode").toUpperCase();
    const result = await this.query<CloudDeviceAuthorizationRow>({
      text: `
        select ${rowColumns()}
        from cloud_device_authorizations
        where user_code = $1
        limit 1
      `,
      values: [userCode],
    });

    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async update(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord> {
    const record = normalizeRecord(input);
    const result = await this.query<CloudDeviceAuthorizationRow>({
      text: `
        update cloud_device_authorizations set
          user_code = $2,
          status = $3,
          client_name = $4,
          device_id = $5,
          desktop_instance_id = $6,
          tenant_id = $7,
          user_id = $8,
          created_at = $9::timestamptz,
          expires_at = $10::timestamptz,
          interval_seconds = $11,
          approved_at = $12::timestamptz,
          denied_at = $13::timestamptz,
          last_polled_at = $14::timestamptz
        where device_code = $1
        returning ${rowColumns()}
      `,
      values: valuesForRecord(record),
    });

    return rowToRecord(requiredRow(result.rows[0], "cloud device authorization update failed"));
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudDeviceAuthorizationQuery,
  ): Promise<PostgresCloudDeviceAuthorizationQueryResult<Row>> {
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

function normalizeRecord(input: CloudDeviceAuthorizationRecord): CloudDeviceAuthorizationRecord {
  return {
    deviceCode: normalizeRequiredCloudRoutingId(input.deviceCode, "deviceCode"),
    userCode: normalizeRequiredCloudRoutingId(input.userCode, "userCode").toUpperCase(),
    status: normalizeStatus(input.status),
    clientName: normalizeOptionalCloudRoutingId(input.clientName, "clientName"),
    deviceId: normalizeOptionalCloudRoutingId(input.deviceId, "deviceId"),
    desktopInstanceId: normalizeOptionalCloudRoutingId(input.desktopInstanceId, "desktopInstanceId"),
    owner: input.owner ? normalizeCloudRouteOwner(input.owner) : undefined,
    createdAt: normalizeRequiredCloudRoutingId(input.createdAt, "createdAt"),
    expiresAt: normalizeRequiredCloudRoutingId(input.expiresAt, "expiresAt"),
    intervalSeconds: input.intervalSeconds,
    approvedAt: normalizeOptionalCloudRoutingId(input.approvedAt, "approvedAt"),
    deniedAt: normalizeOptionalCloudRoutingId(input.deniedAt, "deniedAt"),
    lastPolledAt: normalizeOptionalCloudRoutingId(input.lastPolledAt, "lastPolledAt"),
  };
}

function valuesForRecord(record: CloudDeviceAuthorizationRecord): QueryValue[] {
  return [
    record.deviceCode,
    record.userCode,
    record.status,
    record.clientName ?? null,
    record.deviceId ?? null,
    record.desktopInstanceId ?? null,
    record.owner?.tenantId ?? null,
    record.owner?.userId ?? null,
    record.createdAt,
    record.expiresAt,
    record.intervalSeconds,
    record.approvedAt ?? null,
    record.deniedAt ?? null,
    record.lastPolledAt ?? null,
  ];
}

function rowColumns(): string {
  return `
    device_code,
    user_code,
    status,
    client_name,
    device_id,
    desktop_instance_id,
    tenant_id,
    user_id,
    created_at,
    expires_at,
    interval_seconds,
    approved_at,
    denied_at,
    last_polled_at
  `;
}

function rowToRecord(row: CloudDeviceAuthorizationRow): CloudDeviceAuthorizationRecord {
  return {
    deviceCode: row.device_code,
    userCode: row.user_code,
    status: normalizeStatus(row.status),
    clientName: row.client_name ?? undefined,
    deviceId: row.device_id ?? undefined,
    desktopInstanceId: row.desktop_instance_id ?? undefined,
    owner: row.tenant_id && row.user_id ? { tenantId: row.tenant_id, userId: row.user_id } : undefined,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    intervalSeconds: Number(row.interval_seconds),
    approvedAt: optionalIsoString(row.approved_at),
    deniedAt: optionalIsoString(row.denied_at),
    lastPolledAt: optionalIsoString(row.last_polled_at),
  };
}

function normalizeStatus(value: string): CloudDeviceAuthorizationStatus {
  if (value === "pending" || value === "approved" || value === "denied") return value;
  return "pending";
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresCloudDeviceAuthorizationStoreQueryError(message);
  return row;
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
      throw new PostgresCloudDeviceAuthorizationStoreQueryError(
        "Postgres cloud device authorization mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
