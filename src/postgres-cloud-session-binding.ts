import {
  CloudRoutingError,
  cloudRouteNow,
  isCloudRouteExpired,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
  type BindCloudSessionToDeviceInput,
  type CloudRoutingDeviceRecord,
  type CloudSessionBindingRecord,
  type ResolveCloudSessionDeviceInput,
} from "./cloud-routing-contract.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import type { CloudSessionBindingService } from "./cloud-session-binding.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudSessionBindingQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudSessionBindingQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudSessionBindingQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudSessionBindingQuery,
) => Promise<PostgresCloudSessionBindingQueryResult<Row>>;

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

interface CloudSessionBindingRow {
  tenant_id: string;
  user_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  device_id: string;
  bound_at: string | Date;
  last_seen_at: string | Date;
  expires_at: string | Date | null;
}

export class PostgresCloudSessionBindingQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudSessionBindingQueryError";
  }
}

export class PostgresCloudSessionBindingService implements CloudSessionBindingService {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly routingStore: CloudRoutingStore,
    private readonly queryRunner?: PostgresCloudSessionBindingQueryRunner,
  ) {}

  async bindDevice(input: BindCloudSessionToDeviceInput): Promise<CloudSessionBindingRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    const expiresAt = normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt");
    const device = await this.routingStore.getDevice(owner, deviceId);
    assertDeviceRouteable(device, deviceId, now);

    const existing = await this.getBinding(owner, mcpSessionId);
    if (existing && !sameBinding(existing, { conversationSessionId, deviceId })) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "MCP session is already paired with another conversation or device.",
        { details: { mcpSessionId } },
      );
    }

    const result = await this.query<CloudSessionBindingRow>({
      text: `
        insert into cloud_session_bindings (
          tenant_id,
          user_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          bound_at,
          last_seen_at,
          expires_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::timestamptz,
          $7::timestamptz,
          $8::timestamptz
        )
        on conflict (tenant_id, user_id, mcp_session_id) do update set
          conversation_session_id = excluded.conversation_session_id,
          device_id = excluded.device_id,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at
        returning
          tenant_id,
          user_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          bound_at,
          last_seen_at,
          expires_at
      `,
      values: [
        owner.tenantId,
        owner.userId,
        mcpSessionId,
        conversationSessionId ?? null,
        deviceId,
        now,
        now,
        expiresAt ?? null,
      ],
    });

    return rowToBinding(requiredRow(result.rows[0], "cloud session binding upsert failed"));
  }

  async resolveDevice(input: ResolveCloudSessionDeviceInput): Promise<CloudSessionBindingRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const requestedDeviceId = normalizeOptionalCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    const existing = await this.getBinding(owner, mcpSessionId);

    if (!existing) {
      if (!requestedDeviceId) {
        throw new CloudRoutingError("PAIRING_REQUIRED", "MCP session is not paired with a Desktop device.", {
          details: { mcpSessionId },
        });
      }
      return this.bindDevice({ owner, mcpSessionId, conversationSessionId, deviceId: requestedDeviceId, now });
    }

    if (existing.conversationSessionId && existing.conversationSessionId !== conversationSessionId) {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "MCP session is paired with another conversation.", {
        details: { mcpSessionId },
      });
    }
    if (requestedDeviceId && existing.deviceId !== requestedDeviceId) {
      throw new CloudRoutingError("DEVICE_FORBIDDEN", "MCP session is paired with another device.", {
        details: { deviceId: requestedDeviceId },
      });
    }
    if (isCloudRouteExpired(existing.expiresAt, now)) {
      await this.deleteBinding(owner, mcpSessionId);
      throw new CloudRoutingError("SESSION_EXPIRED", "MCP session device pairing is expired.", {
        details: { mcpSessionId },
      });
    }

    const device = await this.routingStore.getDevice(owner, existing.deviceId);
    assertDeviceRouteable(device, existing.deviceId, now);

    const result = await this.query<CloudSessionBindingRow>({
      text: `
        update cloud_session_bindings
        set last_seen_at = $4::timestamptz
        where tenant_id = $1
          and user_id = $2
          and mcp_session_id = $3
        returning
          tenant_id,
          user_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          bound_at,
          last_seen_at,
          expires_at
      `,
      values: [owner.tenantId, owner.userId, mcpSessionId, now],
    });

    return rowToBinding(requiredRow(result.rows[0], "cloud session binding touch failed"));
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async getBinding(
    owner: WorkspaceIdentity,
    mcpSessionId: string,
  ): Promise<CloudSessionBindingRecord | undefined> {
    const result = await this.query<CloudSessionBindingRow>({
      text: `
        select
          tenant_id,
          user_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          bound_at,
          last_seen_at,
          expires_at
        from cloud_session_bindings
        where tenant_id = $1
          and user_id = $2
          and mcp_session_id = $3
        limit 1
      `,
      values: [owner.tenantId, owner.userId, mcpSessionId],
    });

    const row = result.rows[0];
    return row ? rowToBinding(row) : undefined;
  }

  private async deleteBinding(owner: WorkspaceIdentity, mcpSessionId: string): Promise<void> {
    await this.query({
      text: `
        delete from cloud_session_bindings
        where tenant_id = $1
          and user_id = $2
          and mcp_session_id = $3
      `,
      values: [owner.tenantId, owner.userId, mcpSessionId],
    });
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudSessionBindingQuery,
  ): Promise<PostgresCloudSessionBindingQueryResult<Row>> {
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

function assertDeviceRouteable(
  device: CloudRoutingDeviceRecord | undefined,
  deviceId: string,
  now: string,
): asserts device is CloudRoutingDeviceRecord {
  if (!device || device.status === "revoked") {
    throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
      details: { deviceId },
    });
  }
  if (isCloudRouteExpired(device.expiresAt, now)) {
    throw new CloudRoutingError("SESSION_EXPIRED", "Device route is expired.", {
      details: { deviceId },
    });
  }
  if (device.status !== "online") {
    throw new CloudRoutingError("DEVICE_OFFLINE", "Device is offline.", {
      retryable: true,
      details: { deviceId },
    });
  }
}

function rowToBinding(row: CloudSessionBindingRow): CloudSessionBindingRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    mcpSessionId: row.mcp_session_id,
    conversationSessionId: row.conversation_session_id ?? undefined,
    deviceId: row.device_id,
    boundAt: toIsoString(row.bound_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    expiresAt: optionalIsoString(row.expires_at),
  };
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresCloudSessionBindingQueryError(message);
  return row;
}

function sameBinding(
  existing: CloudSessionBindingRecord,
  next: { conversationSessionId?: string; deviceId: string },
): boolean {
  return existing.conversationSessionId === next.conversationSessionId && existing.deviceId === next.deviceId;
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
      throw new PostgresCloudSessionBindingQueryError(
        "Postgres cloud session binding mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
