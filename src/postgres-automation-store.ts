import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";

export type AutomationSourceKind = "api_trigger" | "github_webhook" | "runtime_hook";
export type AutomationSourceStatus = "enabled" | "disabled";
export type AutomationEventStatus = "accepted" | "rejected";
export type AutomationRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AutomationEventRecordOutcome = "inserted" | "duplicate";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

type QueryValue = string | boolean | number | null;

export interface PostgresAutomationQuery {
  text: string;
  values: QueryValue[];
}

export interface PostgresAutomationQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export type PostgresAutomationQueryRunner = <Row = Record<string, unknown>>(
  query: PostgresAutomationQuery,
) => Promise<PostgresAutomationQueryResult<Row>>;

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

export interface AutomationSource {
  id: string;
  tenantId: string;
  userId: string;
  kind: AutomationSourceKind;
  name: string;
  status: AutomationSourceStatus;
  secretRef?: string;
  tokenHash?: string;
  config: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationEvent {
  id: string;
  tenantId: string;
  userId: string;
  sourceId: string;
  sourceEventId?: string;
  idempotencyKey?: string;
  requestFingerprint: string;
  eventType: string;
  payload: JsonObject;
  metadata: JsonObject;
  devspaceConversationId?: string;
  workspaceSessionId?: string;
  status: AutomationEventStatus;
  receivedAt: string;
}

export interface AutomationRun {
  id: string;
  tenantId: string;
  userId: string;
  eventId: string;
  status: AutomationRunStatus;
  workspaceSessionId?: string;
  devspaceConversationId?: string;
  attempt: number;
  metadata: JsonObject;
  result: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface AutomationSourceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  kind: string;
  name: string;
  status: string;
  secret_ref: string | null;
  token_hash: string | null;
  config: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

interface AutomationEventRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source_id: string;
  source_event_id: string | null;
  idempotency_key: string | null;
  request_fingerprint: string;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  devspace_conversation_id: string | null;
  workspace_session_id: string | null;
  status: string;
  received_at: string | Date;
}

interface AutomationRunRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_id: string;
  status: string;
  workspace_session_id: string | null;
  devspace_conversation_id: string | null;
  attempt: number;
  metadata: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
}

export interface CreateAutomationSourceInput {
  owner: WorkspaceIdentity;
  id: string;
  kind: AutomationSourceKind;
  name: string;
  status?: AutomationSourceStatus;
  secretRef?: string;
  tokenHash?: string;
  config?: JsonObject;
}

export interface ListAutomationSourcesInput {
  owner: WorkspaceIdentity;
  kind?: AutomationSourceKind;
  status?: AutomationSourceStatus;
}

export interface RotateAutomationSourceTokenInput {
  owner: WorkspaceIdentity;
  id: string;
  tokenHash: string;
}

export interface RecordAutomationEventInput {
  owner: WorkspaceIdentity;
  id: string;
  sourceId: string;
  sourceEventId?: string;
  idempotencyKey?: string;
  requestFingerprint: string;
  eventType: string;
  payload?: JsonObject;
  metadata?: JsonObject;
  devspaceConversationId?: string;
  workspaceSessionId?: string;
  status?: AutomationEventStatus;
}

export interface AutomationEventRecordResult {
  outcome: AutomationEventRecordOutcome;
  event: AutomationEvent;
}

export interface CreateAutomationRunInput {
  owner: WorkspaceIdentity;
  id: string;
  eventId: string;
  status?: AutomationRunStatus;
  workspaceSessionId?: string;
  devspaceConversationId?: string;
  attempt?: number;
  metadata?: JsonObject;
  result?: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
}

export class AutomationStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AutomationStoreError";
  }
}

export class AutomationIdempotencyConflictError extends AutomationStoreError {
  constructor(readonly existingEventId: string) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Automation event idempotency key or source event id conflicts with existing event ${existingEventId}.`,
    );
    this.name = "AutomationIdempotencyConflictError";
  }
}

export class PostgresAutomationStoreQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresAutomationStoreQueryError";
  }
}

export class PostgresAutomationStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresAutomationQueryRunner,
  ) {}

  async createSource(input: CreateAutomationSourceInput): Promise<AutomationSource> {
    const now = new Date().toISOString();
    const result = await this.query<AutomationSourceRow>({
      text: `
        insert into automation_sources (
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
        ) values (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::jsonb,
          $10::timestamptz,
          $11::timestamptz
        )
        returning
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
      `,
      values: [
        input.id,
        input.owner.tenantId,
        input.owner.userId,
        input.kind,
        input.name,
        input.status ?? "enabled",
        input.secretRef ?? null,
        input.tokenHash ?? null,
        stringifyJson(input.config ?? {}),
        now,
        now,
      ],
    });

    return rowToAutomationSource(requiredRow(result.rows[0], "automation source insert failed"));
  }

  async getSource(id: string, owner: WorkspaceIdentity): Promise<AutomationSource | undefined> {
    const result = await this.query<AutomationSourceRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
        from automation_sources
        where id = $1
          and tenant_id = $2
          and user_id = $3
        limit 1
      `,
      values: [id, owner.tenantId, owner.userId],
    });

    const row = result.rows[0];
    return row ? rowToAutomationSource(row) : undefined;
  }

  async getApiTriggerSourceForToken(input: {
    triggerId: string;
    tokenHash: string;
  }): Promise<AutomationSource | undefined> {
    const result = await this.query<AutomationSourceRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
        from automation_sources
        where id = $1
          and token_hash = $2
          and kind = 'api_trigger'
        limit 1
      `,
      values: [input.triggerId, input.tokenHash],
    });

    const row = result.rows[0];
    return row ? rowToAutomationSource(row) : undefined;
  }

  async listSources(input: ListAutomationSourcesInput): Promise<AutomationSource[]> {
    const result = await this.query<AutomationSourceRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
        from automation_sources
        where tenant_id = $1
          and user_id = $2
          and ($3::text is null or kind = $3)
          and ($4::text is null or status = $4)
        order by updated_at desc, id asc
      `,
      values: [
        input.owner.tenantId,
        input.owner.userId,
        input.kind ?? null,
        input.status ?? null,
      ],
    });

    return result.rows.map(rowToAutomationSource);
  }

  async rotateSourceToken(input: RotateAutomationSourceTokenInput): Promise<AutomationSource | undefined> {
    const now = new Date().toISOString();
    const result = await this.query<AutomationSourceRow>({
      text: `
        update automation_sources
        set token_hash = $4,
            updated_at = $5::timestamptz
        where id = $1
          and tenant_id = $2
          and user_id = $3
        returning
          id,
          tenant_id,
          user_id,
          kind,
          name,
          status,
          secret_ref,
          token_hash,
          config,
          created_at,
          updated_at
      `,
      values: [
        input.id,
        input.owner.tenantId,
        input.owner.userId,
        input.tokenHash,
        now,
      ],
    });

    const row = result.rows[0];
    return row ? rowToAutomationSource(row) : undefined;
  }

  async recordEvent(input: RecordAutomationEventInput): Promise<AutomationEventRecordResult> {
    const existing = await this.findExistingEventByDedupKey(input);
    if (existing) return this.existingEventResult(existing, input.requestFingerprint);

    const now = new Date().toISOString();
    try {
      const result = await this.query<AutomationEventRow>({
        text: `
          insert into automation_events (
            id,
            tenant_id,
            user_id,
            source_id,
            source_event_id,
            idempotency_key,
            request_fingerprint,
            event_type,
            payload,
            metadata,
            devspace_conversation_id,
            workspace_session_id,
            status,
            received_at
          )
          select
            $4,
            $1,
            $2,
            sources.id,
            $5,
            $6,
            $7,
            $8,
            $9::jsonb,
            $10::jsonb,
            $11,
            $12,
            $13,
            $14::timestamptz
          from automation_sources sources
          where sources.id = $3
            and sources.tenant_id = $1
            and sources.user_id = $2
          returning
            id,
            tenant_id,
            user_id,
            source_id,
            source_event_id,
            idempotency_key,
            request_fingerprint,
            event_type,
            payload,
            metadata,
            devspace_conversation_id,
            workspace_session_id,
            status,
            received_at
        `,
        values: [
          input.owner.tenantId,
          input.owner.userId,
          input.sourceId,
          input.id,
          input.sourceEventId ?? null,
          input.idempotencyKey ?? null,
          input.requestFingerprint,
          input.eventType,
          stringifyJson(input.payload ?? {}),
          stringifyJson(input.metadata ?? {}),
          input.devspaceConversationId ?? null,
          input.workspaceSessionId ?? null,
          input.status ?? "accepted",
          now,
        ],
      });

      const row = result.rows[0];
      if (!row) {
        throw new AutomationStoreError(
          "AUTOMATION_SOURCE_NOT_FOUND",
          `Automation source ${input.sourceId} was not found for the authenticated owner.`,
        );
      }

      return { outcome: "inserted", event: rowToAutomationEvent(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const duplicate = await this.findExistingEventByDedupKey(input);
      if (!duplicate) throw error;
      return this.existingEventResult(duplicate, input.requestFingerprint);
    }
  }

  async getEvent(id: string, owner: WorkspaceIdentity): Promise<AutomationEvent | undefined> {
    const result = await this.query<AutomationEventRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          source_id,
          source_event_id,
          idempotency_key,
          request_fingerprint,
          event_type,
          payload,
          metadata,
          devspace_conversation_id,
          workspace_session_id,
          status,
          received_at
        from automation_events
        where id = $1
          and tenant_id = $2
          and user_id = $3
        limit 1
      `,
      values: [id, owner.tenantId, owner.userId],
    });

    const row = result.rows[0];
    return row ? rowToAutomationEvent(row) : undefined;
  }

  async createRun(input: CreateAutomationRunInput): Promise<AutomationRun> {
    const now = new Date().toISOString();
    const result = await this.query<AutomationRunRow>({
      text: `
        insert into automation_runs (
          id,
          tenant_id,
          user_id,
          event_id,
          status,
          workspace_session_id,
          devspace_conversation_id,
          attempt,
          metadata,
          result,
          error_code,
          error_message,
          created_at,
          started_at,
          finished_at
        )
        select
          $4,
          $1,
          $2,
          events.id,
          $5,
          $6,
          $7,
          $8,
          $9::jsonb,
          $10::jsonb,
          $11,
          $12,
          $13::timestamptz,
          $14::timestamptz,
          $15::timestamptz
        from automation_events events
        where events.id = $3
          and events.tenant_id = $1
          and events.user_id = $2
        returning
          id,
          tenant_id,
          user_id,
          event_id,
          status,
          workspace_session_id,
          devspace_conversation_id,
          attempt,
          metadata,
          result,
          error_code,
          error_message,
          created_at,
          started_at,
          finished_at
      `,
      values: [
        input.owner.tenantId,
        input.owner.userId,
        input.eventId,
        input.id,
        input.status ?? "queued",
        input.workspaceSessionId ?? null,
        input.devspaceConversationId ?? null,
        input.attempt ?? 1,
        stringifyJson(input.metadata ?? {}),
        stringifyJson(input.result ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
        input.startedAt ?? null,
        input.finishedAt ?? null,
      ],
    });

    const row = result.rows[0];
    if (!row) {
      throw new AutomationStoreError(
        "AUTOMATION_EVENT_NOT_FOUND",
        `Automation event ${input.eventId} was not found for the authenticated owner.`,
      );
    }

    return rowToAutomationRun(row);
  }

  async getRun(id: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined> {
    const result = await this.query<AutomationRunRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          event_id,
          status,
          workspace_session_id,
          devspace_conversation_id,
          attempt,
          metadata,
          result,
          error_code,
          error_message,
          created_at,
          started_at,
          finished_at
        from automation_runs
        where id = $1
          and tenant_id = $2
          and user_id = $3
        limit 1
      `,
      values: [id, owner.tenantId, owner.userId],
    });

    const row = result.rows[0];
    return row ? rowToAutomationRun(row) : undefined;
  }

  async getRunForEvent(eventId: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined> {
    const result = await this.query<AutomationRunRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          event_id,
          status,
          workspace_session_id,
          devspace_conversation_id,
          attempt,
          metadata,
          result,
          error_code,
          error_message,
          created_at,
          started_at,
          finished_at
        from automation_runs
        where event_id = $1
          and tenant_id = $2
          and user_id = $3
        order by created_at asc
        limit 1
      `,
      values: [eventId, owner.tenantId, owner.userId],
    });

    const row = result.rows[0];
    return row ? rowToAutomationRun(row) : undefined;
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;

    const pool = await poolPromise;
    await pool.end();
  }

  private async findExistingEventByDedupKey(
    input: Pick<RecordAutomationEventInput, "owner" | "sourceId" | "sourceEventId" | "idempotencyKey">,
  ): Promise<AutomationEvent | undefined> {
    if (!input.sourceEventId && !input.idempotencyKey) return undefined;

    const result = await this.query<AutomationEventRow>({
      text: `
        select
          id,
          tenant_id,
          user_id,
          source_id,
          source_event_id,
          idempotency_key,
          request_fingerprint,
          event_type,
          payload,
          metadata,
          devspace_conversation_id,
          workspace_session_id,
          status,
          received_at
        from automation_events
        where source_id = $1
          and tenant_id = $4
          and user_id = $5
          and (
            ($2::text is not null and source_event_id = $2)
            or ($3::text is not null and idempotency_key = $3)
          )
        limit 1
      `,
      values: [
        input.sourceId,
        input.sourceEventId ?? null,
        input.idempotencyKey ?? null,
        input.owner.tenantId,
        input.owner.userId,
      ],
    });

    const row = result.rows[0];
    return row ? rowToAutomationEvent(row) : undefined;
  }

  private existingEventResult(
    existing: AutomationEvent,
    requestFingerprint: string,
  ): AutomationEventRecordResult {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new AutomationIdempotencyConflictError(existing.id);
    }

    return { outcome: "duplicate", event: existing };
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresAutomationQuery,
  ): Promise<PostgresAutomationQueryResult<Row>> {
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

function rowToAutomationSource(row: AutomationSourceRow): AutomationSource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: automationSourceKind(row.kind),
    name: row.name,
    status: automationSourceStatus(row.status),
    secretRef: row.secret_ref ?? undefined,
    tokenHash: row.token_hash ?? undefined,
    config: jsonObject(row.config),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToAutomationEvent(row: AutomationEventRow): AutomationEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    sourceId: row.source_id,
    sourceEventId: row.source_event_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    requestFingerprint: row.request_fingerprint,
    eventType: row.event_type,
    payload: jsonObject(row.payload),
    metadata: jsonObject(row.metadata),
    devspaceConversationId: row.devspace_conversation_id ?? undefined,
    workspaceSessionId: row.workspace_session_id ?? undefined,
    status: automationEventStatus(row.status),
    receivedAt: toIsoString(row.received_at),
  };
}

function rowToAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    eventId: row.event_id,
    status: automationRunStatus(row.status),
    workspaceSessionId: row.workspace_session_id ?? undefined,
    devspaceConversationId: row.devspace_conversation_id ?? undefined,
    attempt: row.attempt,
    metadata: jsonObject(row.metadata),
    result: jsonObject(row.result),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: toIsoString(row.created_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
  };
}

function automationSourceKind(value: string): AutomationSourceKind {
  if (value === "api_trigger" || value === "github_webhook" || value === "runtime_hook") return value;
  throw new AutomationStoreError("AUTOMATION_SOURCE_KIND_INVALID", `Invalid automation source kind: ${value}`);
}

function automationSourceStatus(value: string): AutomationSourceStatus {
  if (value === "enabled" || value === "disabled") return value;
  throw new AutomationStoreError("AUTOMATION_SOURCE_STATUS_INVALID", `Invalid automation source status: ${value}`);
}

function automationEventStatus(value: string): AutomationEventStatus {
  if (value === "accepted" || value === "rejected") return value;
  throw new AutomationStoreError("AUTOMATION_EVENT_STATUS_INVALID", `Invalid automation event status: ${value}`);
}

function automationRunStatus(value: string): AutomationRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new AutomationStoreError("AUTOMATION_RUN_STATUS_INVALID", `Invalid automation run status: ${value}`);
}

function stringifyJson(value: JsonObject): string {
  return JSON.stringify(value);
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return jsonObject(parsed);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new PostgresAutomationStoreQueryError(message);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function createPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace-automation",
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
    if (isMissingPgDependency(message)) {
      throw new PostgresAutomationStoreQueryError(
        "Postgres automation store requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
      );
    }
    throw error;
  }
}

function isMissingPgDependency(message: string): boolean {
  return message.includes("Cannot find package 'pg'") || message.includes("Cannot find module 'pg'");
}

function sslFor(config: PostgresDatabaseConfig): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.sslMode === "disable") return false;
  if (config.sslMode === "require") return { rejectUnauthorized: false };
  return undefined;
}
