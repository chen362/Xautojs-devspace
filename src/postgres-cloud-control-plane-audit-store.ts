import { randomUUID } from "node:crypto";
import {
  CloudRoutingError,
  cloudRouteNow,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
} from "./cloud-routing-contract.js";
import type {
  CloudControlPlaneAuditAction,
  CloudControlPlaneAuditEvent,
  CloudControlPlaneAuditStatus,
  CloudControlPlaneAuditStore,
  CloudControlPlaneIdempotencyRecord,
  RecordCloudControlPlaneAuditEventInput,
} from "./cloud-control-plane-audit.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudControlPlaneAuditQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudControlPlaneAuditQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudControlPlaneAuditQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudControlPlaneAuditQuery,
) => Promise<PostgresCloudControlPlaneAuditQueryResult<Row>>;

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

interface CloudControlPlaneAuditRow {
  event_id: string;
  tenant_id: string | null;
  user_id: string | null;
  action: string;
  status: string;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  result_json: unknown;
  error_code: string | null;
  created_at: string | Date;
}

export class PostgresCloudControlPlaneAuditStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudControlPlaneAuditStoreQueryError";
  }
}

export class PostgresCloudControlPlaneAuditStore implements CloudControlPlaneAuditStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresCloudControlPlaneAuditQueryRunner,
  ) {}

  async recordEvent<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult>,
  ): Promise<CloudControlPlaneAuditEvent<TResult>> {
    const event = normalizeEventInput(input);
    const result = await this.query<CloudControlPlaneAuditRow>({
      text: `
        insert into cloud_control_plane_audit_events (
          event_id,
          tenant_id,
          user_id,
          action,
          status,
          idempotency_key,
          request_fingerprint,
          result_json,
          error_code,
          created_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb,
          $9,
          $10::timestamptz
        )
        returning ${rowColumns()}
      `,
      values: valuesForEvent(event),
    });

    return rowToEvent<TResult>(requiredRow(result.rows[0], "cloud control-plane audit insert failed"));
  }

  async findIdempotency<TResult = unknown>(
    ownerInput: WorkspaceIdentity,
    action: CloudControlPlaneAuditAction,
    idempotencyKeyInput: string,
  ): Promise<CloudControlPlaneIdempotencyRecord<TResult> | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const idempotencyKey = normalizeRequiredCloudRoutingId(idempotencyKeyInput, "idempotencyKey");
    const result = await this.query<CloudControlPlaneAuditRow>({
      text: `
        select ${rowColumns()}
        from cloud_control_plane_audit_events
        where tenant_id = $1
          and user_id = $2
          and action = $3
          and idempotency_key = $4
        limit 1
      `,
      values: [owner.tenantId, owner.userId, action, idempotencyKey],
    });

    const row = result.rows[0];
    return row ? { event: rowToEvent<TResult>(row), replay: true } : undefined;
  }

  async recordIdempotency<TResult = unknown>(
    input: RecordCloudControlPlaneAuditEventInput<TResult> & {
      owner: WorkspaceIdentity;
      idempotencyKey: string;
      requestFingerprint: string;
      result: TResult;
    },
  ): Promise<CloudControlPlaneAuditEvent<TResult>> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const idempotencyKey = normalizeRequiredCloudRoutingId(input.idempotencyKey, "idempotencyKey");
    const requestFingerprint = normalizeRequiredCloudRoutingId(input.requestFingerprint, "requestFingerprint");
    const existing = await this.findIdempotency<TResult>(owner, input.action, idempotencyKey);

    if (existing) {
      if (existing.event.requestFingerprint !== requestFingerprint) {
        throw new CloudRoutingError("TOOL_CALL_CONFLICT", "Idempotency key was already used with a different request.", {
          details: { action: input.action, idempotencyKey },
        });
      }
      return existing.event;
    }

    return this.recordEvent<TResult>({
      ...input,
      owner,
      idempotencyKey,
      requestFingerprint,
      status: input.status ?? "completed",
    });
  }

  async listEvents(ownerInput?: WorkspaceIdentity): Promise<CloudControlPlaneAuditEvent[]> {
    const owner = ownerInput ? normalizeCloudRouteOwner(ownerInput) : undefined;
    const result = await this.query<CloudControlPlaneAuditRow>({
      text: `
        select ${rowColumns()}
        from cloud_control_plane_audit_events
        where ($1::text is null or tenant_id = $1)
          and ($2::text is null or user_id = $2)
        order by created_at asc
      `,
      values: [owner?.tenantId ?? null, owner?.userId ?? null],
    });

    return result.rows.map(rowToEvent);
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudControlPlaneAuditQuery,
  ): Promise<PostgresCloudControlPlaneAuditQueryResult<Row>> {
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

function normalizeEventInput<TResult>(
  input: RecordCloudControlPlaneAuditEventInput<TResult>,
): CloudControlPlaneAuditEvent<TResult> {
  const owner = input.owner ? normalizeCloudRouteOwner(input.owner) : undefined;
  return {
    eventId: `audit_${randomUUID()}`,
    owner,
    action: input.action,
    status: input.status,
    idempotencyKey: normalizeOptionalCloudRoutingId(input.idempotencyKey, "idempotencyKey"),
    requestFingerprint: normalizeOptionalCloudRoutingId(input.requestFingerprint, "requestFingerprint"),
    result: input.result,
    errorCode: normalizeOptionalCloudRoutingId(input.errorCode, "errorCode"),
    createdAt: cloudRouteNow(input.now),
  };
}

function valuesForEvent(event: CloudControlPlaneAuditEvent): QueryValue[] {
  return [
    event.eventId,
    event.owner?.tenantId ?? null,
    event.owner?.userId ?? null,
    event.action,
    event.status,
    event.idempotencyKey ?? null,
    event.requestFingerprint ?? null,
    JSON.stringify(event.result ?? null),
    event.errorCode ?? null,
    event.createdAt,
  ];
}

function rowColumns(): string {
  return `
    event_id,
    tenant_id,
    user_id,
    action,
    status,
    idempotency_key,
    request_fingerprint,
    result_json,
    error_code,
    created_at
  `;
}

function rowToEvent<TResult = unknown>(row: CloudControlPlaneAuditRow): CloudControlPlaneAuditEvent<TResult> {
  return {
    eventId: row.event_id,
    owner: row.tenant_id && row.user_id ? { tenantId: row.tenant_id, userId: row.user_id } : undefined,
    action: normalizeAction(row.action),
    status: normalizeStatus(row.status),
    idempotencyKey: row.idempotency_key ?? undefined,
    requestFingerprint: row.request_fingerprint ?? undefined,
    result: row.result_json === null ? undefined : row.result_json as TResult,
    errorCode: row.error_code ?? undefined,
    createdAt: toIsoString(row.created_at),
  };
}

function normalizeAction(value: string): CloudControlPlaneAuditAction {
  if (
    value === "device_code.create" ||
    value === "device_code.approve" ||
    value === "device_code.poll" ||
    value === "connect_desktop" ||
    value === "connect_workspace" ||
    value === "route_tool_call"
  ) return value;
  return "route_tool_call";
}

function normalizeStatus(value: string): CloudControlPlaneAuditStatus {
  if (value === "started" || value === "completed" || value === "failed" || value === "conflict") return value;
  return "failed";
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresCloudControlPlaneAuditStoreQueryError(message);
  return row;
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
      throw new PostgresCloudControlPlaneAuditStoreQueryError(
        "Postgres cloud control-plane audit mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
