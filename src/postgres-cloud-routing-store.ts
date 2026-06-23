import {
  CloudRoutingError,
  cloudRouteNow,
  isCloudRouteExpired,
  normalizeCloudRouteCapabilities,
  normalizeCloudRouteOwner,
  normalizeOptionalCloudRoutingId,
  normalizeRequiredCloudRoutingId,
  type BindCloudWorkspaceRouteInput,
  type CloudRoutingDeviceRecord,
  type CloudRoutingDeviceStatus,
  type CloudRoutingToolCallRecord,
  type CloudRoutingToolCallStatus,
  type CloudRoutingWorkspaceRouteRecord,
  type CloudRoutingWorkspaceStatus,
  type CompleteCloudToolCallRouteInput,
  type RegisterCloudRoutingDeviceInput,
  type ResolveCloudWorkspaceRouteInput,
  type ResolvedCloudWorkspaceRoute,
  type SetCloudRoutingDeviceStatusInput,
} from "./cloud-routing-contract.js";
import type { CloudRoutingStore } from "./cloud-routing-store.js";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";

type QueryValue = string | boolean | number | null;

export interface PostgresCloudRoutingQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresCloudRoutingQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresCloudRoutingQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresCloudRoutingQuery,
) => Promise<PostgresCloudRoutingQueryResult<Row>>;

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

interface CloudDeviceRow {
  device_id: string;
  tenant_id: string;
  user_id: string;
  label: string | null;
  capabilities: unknown;
  status: string;
  registered_at: string | Date;
  last_seen_at: string | Date;
  expires_at: string | Date | null;
}

interface CloudWorkspaceRouteRow {
  workspace_id: string;
  tenant_id: string;
  user_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  device_id: string;
  workspace_ref: string | null;
  status: string;
  created_at: string | Date;
  last_routed_at: string | Date | null;
  expires_at: string | Date | null;
}

interface CloudToolCallRow {
  tool_call_id: string;
  tenant_id: string;
  user_id: string;
  mcp_session_id: string;
  conversation_session_id: string | null;
  workspace_id: string;
  device_id: string;
  tool_name: string | null;
  status: string;
  created_at: string | Date;
  last_seen_at: string | Date;
  deadline_at: string | Date | null;
  completed_at: string | Date | null;
}

export class PostgresCloudRoutingStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresCloudRoutingStoreQueryError";
  }
}

export class PostgresCloudRoutingStore implements CloudRoutingStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresCloudRoutingQueryRunner,
  ) {}

  async registerDevice(input: RegisterCloudRoutingDeviceInput): Promise<CloudRoutingDeviceRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    const result = await this.query<CloudDeviceRow>({
      text: `
        insert into cloud_devices (
          tenant_id,
          user_id,
          device_id,
          label,
          capabilities,
          status,
          registered_at,
          last_seen_at,
          expires_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          $6,
          $7::timestamptz,
          $8::timestamptz,
          $9::timestamptz
        )
        on conflict (tenant_id, user_id, device_id) do update set
          label = excluded.label,
          capabilities = excluded.capabilities,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          expires_at = excluded.expires_at
        returning
          tenant_id,
          user_id,
          device_id,
          label,
          capabilities,
          status,
          registered_at,
          last_seen_at,
          expires_at
      `,
      values: [
        owner.tenantId,
        owner.userId,
        deviceId,
        normalizeOptionalCloudRoutingId(input.label, "label") ?? null,
        JSON.stringify(normalizeCloudRouteCapabilities(input.capabilities)),
        input.status ?? "online",
        now,
        now,
        normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt") ?? null,
      ],
    });

    return rowToDevice(requiredRow(result.rows[0], "cloud device upsert failed"));
  }

  async setDeviceStatus(input: SetCloudRoutingDeviceStatusInput): Promise<CloudRoutingDeviceRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const result = await this.query<CloudDeviceRow>({
      text: `
        update cloud_devices
        set status = $4,
            last_seen_at = $5::timestamptz
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
        returning
          tenant_id,
          user_id,
          device_id,
          label,
          capabilities,
          status,
          registered_at,
          last_seen_at,
          expires_at
      `,
      values: [owner.tenantId, owner.userId, deviceId, input.status, cloudRouteNow(input.now)],
    });

    const row = result.rows[0];
    if (!row) {
      throw new CloudRoutingError("DEVICE_NOT_FOUND", "Device is not registered for this owner.", {
        details: { deviceId },
      });
    }
    return rowToDevice(row);
  }

  async getDevice(ownerInput: WorkspaceIdentity, deviceIdInput: string): Promise<CloudRoutingDeviceRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const deviceId = normalizeRequiredCloudRoutingId(deviceIdInput, "deviceId");
    const result = await this.query<CloudDeviceRow>({
      text: `
        select
          tenant_id,
          user_id,
          device_id,
          label,
          capabilities,
          status,
          registered_at,
          last_seen_at,
          expires_at
        from cloud_devices
        where tenant_id = $1
          and user_id = $2
          and device_id = $3
        limit 1
      `,
      values: [owner.tenantId, owner.userId, deviceId],
    });

    const row = result.rows[0];
    return row ? rowToDevice(row) : undefined;
  }

  async bindWorkspaceRoute(input: BindCloudWorkspaceRouteInput): Promise<CloudRoutingWorkspaceRouteRecord> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const workspaceId = normalizeRequiredCloudRoutingId(input.workspaceId, "workspaceId");
    const deviceId = normalizeRequiredCloudRoutingId(input.deviceId, "deviceId");
    const now = cloudRouteNow(input.now);
    this.assertDeviceRouteable(await this.getDevice(owner, deviceId), deviceId, now);

    const existing = await this.getWorkspaceRoute(owner, workspaceId);
    if (existing && !sameWorkspaceBinding(existing, { mcpSessionId, conversationSessionId, deviceId })) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "workspaceId is already bound to another MCP session, conversation, or device.",
        { details: { workspaceId, mcpSessionId } },
      );
    }

    const result = await this.query<CloudWorkspaceRouteRow>({
      text: `
        insert into cloud_workspace_routes (
          tenant_id,
          user_id,
          workspace_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          workspace_ref,
          status,
          created_at,
          last_routed_at,
          expires_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          'active',
          $8::timestamptz,
          null,
          $9::timestamptz
        )
        on conflict (tenant_id, user_id, workspace_id) do update set
          mcp_session_id = excluded.mcp_session_id,
          conversation_session_id = excluded.conversation_session_id,
          device_id = excluded.device_id,
          workspace_ref = excluded.workspace_ref,
          status = 'active',
          expires_at = excluded.expires_at
        returning
          tenant_id,
          user_id,
          workspace_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          workspace_ref,
          status,
          created_at,
          last_routed_at,
          expires_at
      `,
      values: [
        owner.tenantId,
        owner.userId,
        workspaceId,
        mcpSessionId,
        conversationSessionId ?? null,
        deviceId,
        normalizeOptionalCloudRoutingId(input.workspaceRef, "workspaceRef") ?? null,
        now,
        normalizeOptionalCloudRoutingId(input.expiresAt, "expiresAt") ?? null,
      ],
    });

    return rowToWorkspaceRoute(requiredRow(result.rows[0], "cloud workspace route upsert failed"));
  }

  async resolveWorkspaceRoute(input: ResolveCloudWorkspaceRouteInput): Promise<ResolvedCloudWorkspaceRoute> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const mcpSessionId = normalizeRequiredCloudRoutingId(input.mcpSessionId, "mcpSessionId");
    const conversationSessionId = normalizeOptionalCloudRoutingId(
      input.conversationSessionId,
      "conversationSessionId",
    );
    const workspaceId = normalizeRequiredCloudRoutingId(input.workspaceId, "workspaceId");
    const toolCallId = input.toolCallId === undefined
      ? undefined
      : normalizeRequiredCloudRoutingId(input.toolCallId, "toolCallId");
    const now = cloudRouteNow(input.now);
    const route = await this.getWorkspaceRoute(owner, workspaceId);

    if (!route) {
      throw new CloudRoutingError("WORKSPACE_NOT_FOUND", "workspaceId is unknown for this owner.", {
        details: { workspaceId },
      });
    }

    this.assertWorkspaceRouteable(route, { mcpSessionId, conversationSessionId, now });

    const device = await this.getDevice(owner, route.deviceId);
    this.assertDeviceRouteable(device, route.deviceId, now);

    const updatedRoute = await this.touchWorkspaceRoute(owner, workspaceId, now);
    const toolCall = toolCallId
      ? await this.recordToolCallRoute({
          owner,
          route: updatedRoute,
          toolCallId,
          tool: input.tool,
          now,
          deadlineAt: input.deadlineAt,
        })
      : undefined;

    return {
      workspace: updatedRoute,
      device,
      toolCall,
      routedAt: now,
    };
  }

  async getToolCallRoute(
    ownerInput: WorkspaceIdentity,
    toolCallIdInput: string,
  ): Promise<CloudRoutingToolCallRecord | undefined> {
    const owner = normalizeCloudRouteOwner(ownerInput);
    const toolCallId = normalizeRequiredCloudRoutingId(toolCallIdInput, "toolCallId");
    const result = await this.query<CloudToolCallRow>({
      text: `
        select
          tenant_id,
          user_id,
          tool_call_id,
          mcp_session_id,
          conversation_session_id,
          workspace_id,
          device_id,
          tool_name,
          status,
          created_at,
          last_seen_at,
          deadline_at,
          completed_at
        from cloud_tool_calls
        where tenant_id = $1
          and user_id = $2
          and tool_call_id = $3
        limit 1
      `,
      values: [owner.tenantId, owner.userId, toolCallId],
    });

    const row = result.rows[0];
    return row ? rowToToolCall(row) : undefined;
  }

  async completeToolCallRoute(input: CompleteCloudToolCallRouteInput): Promise<CloudRoutingToolCallRecord | undefined> {
    const owner = normalizeCloudRouteOwner(input.owner);
    const toolCallId = normalizeRequiredCloudRoutingId(input.toolCallId, "toolCallId");
    const now = cloudRouteNow(input.now);
    const result = await this.query<CloudToolCallRow>({
      text: `
        update cloud_tool_calls
        set status = $4,
            last_seen_at = $5::timestamptz,
            completed_at = $6::timestamptz
        where tenant_id = $1
          and user_id = $2
          and tool_call_id = $3
        returning
          tenant_id,
          user_id,
          tool_call_id,
          mcp_session_id,
          conversation_session_id,
          workspace_id,
          device_id,
          tool_name,
          status,
          created_at,
          last_seen_at,
          deadline_at,
          completed_at
      `,
      values: [owner.tenantId, owner.userId, toolCallId, input.status ?? "completed", now, now],
    });

    const row = result.rows[0];
    return row ? rowToToolCall(row) : undefined;
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async getWorkspaceRoute(
    owner: WorkspaceIdentity,
    workspaceId: string,
  ): Promise<CloudRoutingWorkspaceRouteRecord | undefined> {
    const result = await this.query<CloudWorkspaceRouteRow>({
      text: `
        select
          tenant_id,
          user_id,
          workspace_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          workspace_ref,
          status,
          created_at,
          last_routed_at,
          expires_at
        from cloud_workspace_routes
        where tenant_id = $1
          and user_id = $2
          and workspace_id = $3
        limit 1
      `,
      values: [owner.tenantId, owner.userId, workspaceId],
    });

    const row = result.rows[0];
    return row ? rowToWorkspaceRoute(row) : undefined;
  }

  private async touchWorkspaceRoute(
    owner: WorkspaceIdentity,
    workspaceId: string,
    now: string,
  ): Promise<CloudRoutingWorkspaceRouteRecord> {
    const result = await this.query<CloudWorkspaceRouteRow>({
      text: `
        update cloud_workspace_routes
        set last_routed_at = $4::timestamptz
        where tenant_id = $1
          and user_id = $2
          and workspace_id = $3
        returning
          tenant_id,
          user_id,
          workspace_id,
          mcp_session_id,
          conversation_session_id,
          device_id,
          workspace_ref,
          status,
          created_at,
          last_routed_at,
          expires_at
      `,
      values: [owner.tenantId, owner.userId, workspaceId, now],
    });

    return rowToWorkspaceRoute(requiredRow(result.rows[0], "cloud workspace route touch failed"));
  }

  private async recordToolCallRoute(input: {
    owner: WorkspaceIdentity;
    route: CloudRoutingWorkspaceRouteRecord;
    toolCallId: string;
    tool?: ResolveCloudWorkspaceRouteInput["tool"];
    now: string;
    deadlineAt?: string;
  }): Promise<CloudRoutingToolCallRecord> {
    const existing = await this.getToolCallRoute(input.owner, input.toolCallId);
    const nextRoute = {
      mcpSessionId: input.route.mcpSessionId,
      conversationSessionId: input.route.conversationSessionId,
      workspaceId: input.route.workspaceId,
      deviceId: input.route.deviceId,
      tool: input.tool,
    };

    if (existing) {
      if (!sameToolCallRoute(existing, nextRoute)) {
        throw new CloudRoutingError(
          "TOOL_CALL_CONFLICT",
          "toolCallId has already been routed to a different workspace, device, or tool.",
          { details: { toolCallId: input.toolCallId } },
        );
      }

      const result = await this.query<CloudToolCallRow>({
        text: `
          update cloud_tool_calls
          set last_seen_at = $4::timestamptz
          where tenant_id = $1
            and user_id = $2
            and tool_call_id = $3
          returning
            tenant_id,
            user_id,
            tool_call_id,
            mcp_session_id,
            conversation_session_id,
            workspace_id,
            device_id,
            tool_name,
            status,
            created_at,
            last_seen_at,
            deadline_at,
            completed_at
        `,
        values: [input.owner.tenantId, input.owner.userId, input.toolCallId, input.now],
      });
      return rowToToolCall(requiredRow(result.rows[0], "cloud tool call touch failed"));
    }

    const result = await this.query<CloudToolCallRow>({
      text: `
        insert into cloud_tool_calls (
          tenant_id,
          user_id,
          tool_call_id,
          mcp_session_id,
          conversation_session_id,
          workspace_id,
          device_id,
          tool_name,
          status,
          created_at,
          last_seen_at,
          deadline_at,
          completed_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          'routed',
          $9::timestamptz,
          $10::timestamptz,
          $11::timestamptz,
          null
        )
        returning
          tenant_id,
          user_id,
          tool_call_id,
          mcp_session_id,
          conversation_session_id,
          workspace_id,
          device_id,
          tool_name,
          status,
          created_at,
          last_seen_at,
          deadline_at,
          completed_at
      `,
      values: [
        input.owner.tenantId,
        input.owner.userId,
        input.toolCallId,
        input.route.mcpSessionId,
        input.route.conversationSessionId ?? null,
        input.route.workspaceId,
        input.route.deviceId,
        input.tool ?? null,
        input.now,
        input.now,
        normalizeOptionalCloudRoutingId(input.deadlineAt, "deadlineAt") ?? null,
      ],
    });
    return rowToToolCall(requiredRow(result.rows[0], "cloud tool call insert failed"));
  }

  private assertWorkspaceRouteable(
    route: CloudRoutingWorkspaceRouteRecord,
    input: { mcpSessionId: string; conversationSessionId?: string; now: string },
  ): void {
    if (route.mcpSessionId !== input.mcpSessionId) {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "workspaceId belongs to another MCP session.", {
        details: { workspaceId: route.workspaceId, mcpSessionId: input.mcpSessionId },
      });
    }
    if (route.conversationSessionId && route.conversationSessionId !== input.conversationSessionId) {
      throw new CloudRoutingError(
        "WORKSPACE_FORBIDDEN",
        "workspaceId belongs to another conversation session.",
        { details: { workspaceId: route.workspaceId } },
      );
    }
    if (route.status === "revoked") {
      throw new CloudRoutingError("WORKSPACE_FORBIDDEN", "workspace route is revoked.", {
        details: { workspaceId: route.workspaceId },
      });
    }
    if (route.status === "expired" || isCloudRouteExpired(route.expiresAt, input.now)) {
      throw new CloudRoutingError("SESSION_EXPIRED", "workspace route is expired.", {
        details: { workspaceId: route.workspaceId },
      });
    }
  }

  private assertDeviceRouteable(
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

  private async query<Row = Record<string, unknown>>(
    query: PostgresCloudRoutingQuery,
  ): Promise<PostgresCloudRoutingQueryResult<Row>> {
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

function rowToDevice(row: CloudDeviceRow): CloudRoutingDeviceRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    deviceId: row.device_id,
    label: row.label ?? undefined,
    capabilities: parseStringArray(row.capabilities),
    status: deviceStatus(row.status),
    registeredAt: toIsoString(row.registered_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    expiresAt: optionalIsoString(row.expires_at),
  };
}

function rowToWorkspaceRoute(row: CloudWorkspaceRouteRow): CloudRoutingWorkspaceRouteRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    workspaceId: row.workspace_id,
    mcpSessionId: row.mcp_session_id,
    conversationSessionId: row.conversation_session_id ?? undefined,
    deviceId: row.device_id,
    workspaceRef: row.workspace_ref ?? undefined,
    status: workspaceStatus(row.status),
    createdAt: toIsoString(row.created_at),
    lastRoutedAt: optionalIsoString(row.last_routed_at),
    expiresAt: optionalIsoString(row.expires_at),
  };
}

function rowToToolCall(row: CloudToolCallRow): CloudRoutingToolCallRecord {
  return {
    owner: { tenantId: row.tenant_id, userId: row.user_id },
    toolCallId: row.tool_call_id,
    mcpSessionId: row.mcp_session_id,
    conversationSessionId: row.conversation_session_id ?? undefined,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    tool: row.tool_name === null ? undefined : toolName(row.tool_name),
    status: toolCallStatus(row.status),
    createdAt: toIsoString(row.created_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    deadlineAt: optionalIsoString(row.deadline_at),
    completedAt: optionalIsoString(row.completed_at),
  };
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresCloudRoutingStoreQueryError(message);
  return row;
}

function sameWorkspaceBinding(
  existing: CloudRoutingWorkspaceRouteRecord,
  next: { mcpSessionId: string; conversationSessionId?: string; deviceId: string },
): boolean {
  return (
    existing.mcpSessionId === next.mcpSessionId &&
    existing.conversationSessionId === next.conversationSessionId &&
    existing.deviceId === next.deviceId
  );
}

function sameToolCallRoute(
  existing: CloudRoutingToolCallRecord,
  next: {
    mcpSessionId: string;
    conversationSessionId?: string;
    workspaceId: string;
    deviceId: string;
    tool?: ResolveCloudWorkspaceRouteInput["tool"];
  },
): boolean {
  return (
    existing.mcpSessionId === next.mcpSessionId &&
    existing.conversationSessionId === next.conversationSessionId &&
    existing.workspaceId === next.workspaceId &&
    existing.deviceId === next.deviceId &&
    existing.tool === next.tool
  );
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function deviceStatus(value: string): CloudRoutingDeviceStatus {
  if (value === "online" || value === "offline" || value === "revoked") return value;
  return "offline";
}

function workspaceStatus(value: string): CloudRoutingWorkspaceStatus {
  if (value === "active" || value === "expired" || value === "revoked") return value;
  return "expired";
}

function toolCallStatus(value: string): CloudRoutingToolCallStatus {
  if (value === "routed" || value === "completed" || value === "failed" || value === "cancelled") return value;
  return "failed";
}

function toolName(value: string): ResolveCloudWorkspaceRouteInput["tool"] {
  if (
    value === "open_workspace" ||
    value === "read_file" ||
    value === "write_file" ||
    value === "edit_file" ||
    value === "grep_files" ||
    value === "find_files" ||
    value === "list_directory" ||
    value === "run_shell" ||
    value === "show_changes"
  ) {
    return value;
  }
  return undefined;
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
      throw new PostgresCloudRoutingStoreQueryError(
        "Postgres cloud routing mode requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
