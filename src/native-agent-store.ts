import { randomUUID } from "node:crypto";
import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";
import type {
  AutomationRun,
  AutomationRunStatus,
  JsonObject,
  JsonValue,
  PostgresAutomationQuery,
  PostgresAutomationQueryResult,
  PostgresAutomationQueryRunner,
} from "./postgres-automation-store.js";

export type NativeAgentRunStatus =
  | "queued"
  | "claiming"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";
export type NativeAgentPermissionProfile = "read_only" | "workspace_write" | "trusted_local";
export type NativeAgentToolRisk = "low" | "medium" | "high";
export type NativeAgentToolCallStatus = "running" | "succeeded" | "failed" | "blocked";
export type NativeRuntimeHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "PostCompact" | "Stop";
export type NativeRuntimeHookDecision = "allow" | "block" | "ask" | "deny" | "audit_only";

export interface NativeAgentRun {
  id: string;
  tenantId: string;
  userId: string;
  automationRunId?: string;
  workspaceSessionId?: string;
  workflowId: string;
  status: NativeAgentRunStatus;
  attempt: number;
  permissionProfile: NativeAgentPermissionProfile;
  input: JsonObject;
  result: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface NativeAgentRunEvent {
  id: string;
  agentRunId: string;
  seq: number;
  type: string;
  payload: JsonObject;
  createdAt: string;
}

export interface NativeAgentToolCall {
  id: string;
  agentRunId: string;
  toolName: string;
  status: NativeAgentToolCallStatus;
  risk: NativeAgentToolRisk;
  input: JsonObject;
  result: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface NativeRuntimeHookRecord {
  id: string;
  agentRunId?: string;
  hookEventName: NativeRuntimeHookEventName;
  decision: NativeRuntimeHookDecision;
  payload: JsonObject;
  result: JsonObject;
  createdAt: string;
}

export interface ClaimAutomationRunInput {
  automationRunId?: string;
  workflowId?: string;
  workspaceSessionId?: string;
  permissionProfile?: NativeAgentPermissionProfile;
  input?: JsonObject;
}

export interface CreateAgentRunInput {
  owner: WorkspaceIdentity;
  id?: string;
  automationRunId?: string;
  workspaceSessionId?: string;
  workflowId: string;
  status?: NativeAgentRunStatus;
  attempt?: number;
  permissionProfile?: NativeAgentPermissionProfile;
  input?: JsonObject;
}

export interface FinishAgentRunInput {
  agentRunId: string;
  status: Extract<NativeAgentRunStatus, "succeeded" | "failed" | "cancelled" | "timed_out">;
  result?: JsonObject;
  errorCode?: string;
  errorMessage?: string;
}

export interface UpdateAgentRunStatusInput {
  agentRunId: string;
  status: Extract<NativeAgentRunStatus, "queued" | "claiming" | "running" | "waiting_input">;
  result?: JsonObject;
  errorCode?: string;
  errorMessage?: string;
}

export interface ReadAgentRunEventsInput {
  agentRunId: string;
  afterSeq?: number;
  maxEvents?: number;
}

export interface NativeAgentStore {
  claimAutomationRun(input?: ClaimAutomationRunInput): Promise<NativeAgentRun | undefined>;
  createAgentRun(input: CreateAgentRunInput): Promise<NativeAgentRun>;
  getAgentRun(id: string, owner?: WorkspaceIdentity): Promise<NativeAgentRun | undefined>;
  getAgentRunForAutomationRun(automationRunId: string): Promise<NativeAgentRun | undefined>;
  listAgentRuns(input?: {
    owner?: WorkspaceIdentity;
    status?: NativeAgentRunStatus;
    limit?: number;
  }): Promise<NativeAgentRun[]>;
  appendRunEvent(input: {
    agentRunId: string;
    type: string;
    payload?: JsonObject;
    id?: string;
  }): Promise<NativeAgentRunEvent>;
  readRunEvents(input: ReadAgentRunEventsInput): Promise<NativeAgentRunEvent[]>;
  finishAgentRun(input: FinishAgentRunInput): Promise<NativeAgentRun | undefined>;
  setAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<NativeAgentRun | undefined>;
  cancelAgentRun(input: { agentRunId: string; reason?: string }): Promise<NativeAgentRun | undefined>;
  recordToolCallStart(input: {
    id?: string;
    agentRunId: string;
    toolName: string;
    risk?: NativeAgentToolRisk;
    input?: JsonObject;
  }): Promise<NativeAgentToolCall>;
  finishToolCall(input: {
    id: string;
    status: Exclude<NativeAgentToolCallStatus, "running">;
    result?: JsonObject;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<NativeAgentToolCall | undefined>;
  recordRuntimeHook(input: {
    id?: string;
    agentRunId?: string;
    hookEventName: NativeRuntimeHookEventName;
    decision: NativeRuntimeHookDecision;
    payload?: JsonObject;
    result?: JsonObject;
  }): Promise<NativeRuntimeHookRecord>;
  close?(): Promise<void>;
}

type QueryValue = string | boolean | number | null;

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

interface AgentRunRow {
  id: string;
  tenant_id: string;
  user_id: string;
  automation_run_id: string | null;
  workspace_session_id: string | null;
  workflow_id: string;
  status: string;
  attempt: number;
  permission_profile: string;
  input: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: string | Date;
  claimed_at: string | Date | null;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  updated_at: string | Date;
}

interface AgentRunEventRow {
  id: string;
  agent_run_id: string;
  seq: number;
  event_type: string;
  payload: unknown;
  created_at: string | Date;
}

interface AgentToolCallRow {
  id: string;
  agent_run_id: string;
  tool_name: string;
  status: string;
  risk: string;
  input: unknown;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
}

interface RuntimeHookRow {
  id: string;
  agent_run_id: string | null;
  hook_event_name: string;
  decision: string;
  payload: unknown;
  result: unknown;
  created_at: string | Date;
}

export class PostgresNativeAgentStore implements NativeAgentStore {
  private poolPromise: Promise<PgPool> | undefined;

  constructor(
    readonly config: PostgresDatabaseConfig,
    private readonly queryRunner?: PostgresAutomationQueryRunner,
  ) {}

  async claimAutomationRun(input: ClaimAutomationRunInput = {}): Promise<NativeAgentRun | undefined> {
    const now = new Date().toISOString();
    const id = `agent_run_${randomUUID()}`;
    const workflowId = input.workflowId ?? null;
    const permissionProfile = input.permissionProfile ?? "workspace_write";
    const inputJson = stringifyJson(input.input ?? {});
    const workspaceSessionId = input.workspaceSessionId ?? null;

    const result = input.automationRunId
      ? await this.query<AgentRunRow>({
          text: `
            with claimed as (
              update automation_runs
              set status = 'running',
                  started_at = coalesce(started_at, $7::timestamptz)
              where id = $1
                and status = 'queued'
              returning id, tenant_id, user_id, workspace_session_id, metadata, result
            )
            insert into agent_runs (
              id,
              tenant_id,
              user_id,
              automation_run_id,
              workspace_session_id,
              workflow_id,
              status,
              attempt,
              permission_profile,
              input,
              result,
              created_at,
              claimed_at,
              started_at,
              updated_at
            )
            select
              $2,
              tenant_id,
              user_id,
              id,
              coalesce($5, workspace_session_id),
              coalesce($3, nullif(metadata->>'workflowId', ''), case when metadata->>'provider' = 'github' then 'github-pr-review' else 'manual' end),
              'running',
              1,
              $4,
              case when $6::jsonb = '{}'::jsonb
                then jsonb_build_object('automationRunId', id, 'metadata', metadata, 'result', result)
                else $6::jsonb
              end,
              '{}'::jsonb,
              $7::timestamptz,
              $7::timestamptz,
              $7::timestamptz,
              $7::timestamptz
            from claimed
            on conflict (automation_run_id) do nothing
            returning
              id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
              status, attempt, permission_profile, input, result, error_code, error_message,
              created_at, claimed_at, started_at, finished_at, updated_at
          `,
          values: [input.automationRunId, id, workflowId, permissionProfile, workspaceSessionId, inputJson, now],
        })
      : await this.query<AgentRunRow>({
          text: `
            with candidate as (
              select id
              from automation_runs
              where status = 'queued'
              order by created_at asc
              limit 1
              for update skip locked
            ), claimed as (
              update automation_runs runs
              set status = 'running',
                  started_at = coalesce(started_at, $6::timestamptz)
              from candidate
              where runs.id = candidate.id
              returning runs.id, runs.tenant_id, runs.user_id, runs.workspace_session_id, runs.metadata, runs.result
            )
            insert into agent_runs (
              id,
              tenant_id,
              user_id,
              automation_run_id,
              workspace_session_id,
              workflow_id,
              status,
              attempt,
              permission_profile,
              input,
              result,
              created_at,
              claimed_at,
              started_at,
              updated_at
            )
            select
              $1,
              tenant_id,
              user_id,
              id,
              coalesce($4, workspace_session_id),
              coalesce($2, nullif(metadata->>'workflowId', ''), case when metadata->>'provider' = 'github' then 'github-pr-review' else 'manual' end),
              'running',
              1,
              $3,
              case when $5::jsonb = '{}'::jsonb
                then jsonb_build_object('automationRunId', id, 'metadata', metadata, 'result', result)
                else $5::jsonb
              end,
              '{}'::jsonb,
              $6::timestamptz,
              $6::timestamptz,
              $6::timestamptz,
              $6::timestamptz
            from claimed
            on conflict (automation_run_id) do nothing
            returning
              id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
              status, attempt, permission_profile, input, result, error_code, error_message,
              created_at, claimed_at, started_at, finished_at, updated_at
          `,
          values: [id, workflowId, permissionProfile, workspaceSessionId, inputJson, now],
        });

    const row = result.rows[0];
    return row ? rowToAgentRun(row) : undefined;
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<NativeAgentRun> {
    const now = new Date().toISOString();
    const result = await this.query<AgentRunRow>({
      text: `
        insert into agent_runs (
          id,
          tenant_id,
          user_id,
          automation_run_id,
          workspace_session_id,
          workflow_id,
          status,
          attempt,
          permission_profile,
          input,
          result,
          created_at,
          claimed_at,
          started_at,
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
          $9,
          $10::jsonb,
          '{}'::jsonb,
          $11::timestamptz,
          $12::timestamptz,
          $13::timestamptz,
          $11::timestamptz
        )
        returning
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
      `,
      values: [
        input.id ?? `agent_run_${randomUUID()}`,
        input.owner.tenantId,
        input.owner.userId,
        input.automationRunId ?? null,
        input.workspaceSessionId ?? null,
        input.workflowId,
        input.status ?? "queued",
        input.attempt ?? 1,
        input.permissionProfile ?? "workspace_write",
        stringifyJson(input.input ?? {}),
        now,
        input.status === "queued" ? null : now,
        input.status === "running" || input.status === "waiting_input" ? now : null,
      ],
    });

    return rowToAgentRun(requiredRow(result.rows[0], "agent run insert failed"));
  }

  async getAgentRun(id: string, owner?: WorkspaceIdentity): Promise<NativeAgentRun | undefined> {
    const result = await this.query<AgentRunRow>({
      text: `
        select
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
        from agent_runs
        where id = $1
          and ($2::text is null or tenant_id = $2)
          and ($3::text is null or user_id = $3)
        limit 1
      `,
      values: [id, owner?.tenantId ?? null, owner?.userId ?? null],
    });

    const row = result.rows[0];
    return row ? rowToAgentRun(row) : undefined;
  }

  async getAgentRunForAutomationRun(automationRunId: string): Promise<NativeAgentRun | undefined> {
    const result = await this.query<AgentRunRow>({
      text: `
        select
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
        from agent_runs
        where automation_run_id = $1
        limit 1
      `,
      values: [automationRunId],
    });

    const row = result.rows[0];
    return row ? rowToAgentRun(row) : undefined;
  }

  async listAgentRuns(input: {
    owner?: WorkspaceIdentity;
    status?: NativeAgentRunStatus;
    limit?: number;
  } = {}): Promise<NativeAgentRun[]> {
    const result = await this.query<AgentRunRow>({
      text: `
        select
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
        from agent_runs
        where ($1::text is null or tenant_id = $1)
          and ($2::text is null or user_id = $2)
          and ($3::text is null or status = $3)
        order by created_at desc
        limit $4
      `,
      values: [input.owner?.tenantId ?? null, input.owner?.userId ?? null, input.status ?? null, boundedLimit(input.limit)],
    });

    return result.rows.map(rowToAgentRun);
  }

  async appendRunEvent(input: {
    agentRunId: string;
    type: string;
    payload?: JsonObject;
    id?: string;
  }): Promise<NativeAgentRunEvent> {
    const now = new Date().toISOString();
    const result = await this.query<AgentRunEventRow>({
      text: `
        insert into agent_run_events (id, agent_run_id, seq, event_type, payload, created_at)
        select
          $2,
          runs.id,
          coalesce((select max(seq) + 1 from agent_run_events where agent_run_id = $1), 1),
          $3,
          $4::jsonb,
          $5::timestamptz
        from agent_runs runs
        where runs.id = $1
        returning id, agent_run_id, seq, event_type, payload, created_at
      `,
      values: [input.agentRunId, input.id ?? `agent_evt_${randomUUID()}`, input.type, stringifyJson(input.payload ?? {}), now],
    });

    return rowToRunEvent(requiredRow(result.rows[0], `agent run not found: ${input.agentRunId}`));
  }

  async readRunEvents(input: ReadAgentRunEventsInput): Promise<NativeAgentRunEvent[]> {
    const result = await this.query<AgentRunEventRow>({
      text: `
        select id, agent_run_id, seq, event_type, payload, created_at
        from agent_run_events
        where agent_run_id = $1
          and seq > $2
        order by seq asc
        limit $3
      `,
      values: [input.agentRunId, input.afterSeq ?? 0, boundedLimit(input.maxEvents)],
    });

    return result.rows.map(rowToRunEvent);
  }

  async finishAgentRun(input: FinishAgentRunInput): Promise<NativeAgentRun | undefined> {
    const now = new Date().toISOString();
    const result = await this.query<AgentRunRow>({
      text: `
        update agent_runs
        set status = $2,
            result = $3::jsonb,
            error_code = $4,
            error_message = $5,
            finished_at = $6::timestamptz,
            updated_at = $6::timestamptz
        where id = $1
        returning
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
      `,
      values: [
        input.agentRunId,
        input.status,
        stringifyJson(input.result ?? {}),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
      ],
    });
    const row = result.rows[0];
    if (!row) return undefined;

    const run = rowToAgentRun(row);
    if (run.automationRunId) {
      await this.query({
        text: `
          update automation_runs
          set status = $2,
              result = $3::jsonb,
              error_code = $4,
              error_message = $5,
              finished_at = $6::timestamptz
          where id = $1
        `,
        values: [
          run.automationRunId,
          automationStatusForAgentStatus(run.status),
          stringifyJson(run.result),
          run.errorCode ?? null,
          run.errorMessage ?? null,
          now,
        ],
      });
    }
    return run;
  }

  async setAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<NativeAgentRun | undefined> {
    const now = new Date().toISOString();
    const result = await this.query<AgentRunRow>({
      text: `
        update agent_runs
        set status = $2,
            result = case when $3::jsonb is null then result else $3::jsonb end,
            error_code = $4,
            error_message = $5,
            claimed_at = case
              when $2 in ('claiming', 'running', 'waiting_input') then coalesce(claimed_at, $6::timestamptz)
              else claimed_at
            end,
            started_at = case
              when $2 in ('running', 'waiting_input') then coalesce(started_at, $6::timestamptz)
              else started_at
            end,
            updated_at = $6::timestamptz
        where id = $1
          and status not in ('succeeded', 'failed', 'cancelled', 'timed_out')
        returning
          id, tenant_id, user_id, automation_run_id, workspace_session_id, workflow_id,
          status, attempt, permission_profile, input, result, error_code, error_message,
          created_at, claimed_at, started_at, finished_at, updated_at
      `,
      values: [
        input.agentRunId,
        input.status,
        input.result ? stringifyJson(input.result) : null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        now,
      ],
    });
    const row = result.rows[0];
    if (!row) return undefined;

    const run = rowToAgentRun(row);
    if (run.automationRunId) {
      await this.query({
        text: `
          update automation_runs
          set status = $2,
              result = $3::jsonb,
              error_code = $4,
              error_message = $5
          where id = $1
        `,
        values: [
          run.automationRunId,
          automationStatusForAgentStatus(run.status),
          stringifyJson(run.result),
          run.errorCode ?? null,
          run.errorMessage ?? null,
        ],
      });
    }
    return run;
  }

  async cancelAgentRun(input: { agentRunId: string; reason?: string }): Promise<NativeAgentRun | undefined> {
    await this.appendRunEvent({
      agentRunId: input.agentRunId,
      type: "run.cancel_requested",
      payload: { reason: input.reason ?? null },
    });
    return this.finishAgentRun({
      agentRunId: input.agentRunId,
      status: "cancelled",
      errorCode: "AGENT_RUN_CANCELLED",
      errorMessage: input.reason ?? "Native agent run was cancelled.",
    });
  }

  async recordToolCallStart(input: {
    id?: string;
    agentRunId: string;
    toolName: string;
    risk?: NativeAgentToolRisk;
    input?: JsonObject;
  }): Promise<NativeAgentToolCall> {
    const now = new Date().toISOString();
    const result = await this.query<AgentToolCallRow>({
      text: `
        insert into agent_tool_calls (
          id, agent_run_id, tool_name, status, risk, input, result, started_at
        ) values ($1, $2, $3, 'running', $4, $5::jsonb, '{}'::jsonb, $6::timestamptz)
        returning
          id, agent_run_id, tool_name, status, risk, input, result,
          error_code, error_message, started_at, finished_at
      `,
      values: [
        input.id ?? `agent_tool_${randomUUID()}`,
        input.agentRunId,
        input.toolName,
        input.risk ?? "low",
        stringifyJson(input.input ?? {}),
        now,
      ],
    });

    return rowToToolCall(requiredRow(result.rows[0], "agent tool call insert failed"));
  }

  async finishToolCall(input: {
    id: string;
    status: Exclude<NativeAgentToolCallStatus, "running">;
    result?: JsonObject;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<NativeAgentToolCall | undefined> {
    const now = new Date().toISOString();
    const result = await this.query<AgentToolCallRow>({
      text: `
        update agent_tool_calls
        set status = $2,
            result = $3::jsonb,
            error_code = $4,
            error_message = $5,
            finished_at = $6::timestamptz
        where id = $1
        returning
          id, agent_run_id, tool_name, status, risk, input, result,
          error_code, error_message, started_at, finished_at
      `,
      values: [input.id, input.status, stringifyJson(input.result ?? {}), input.errorCode ?? null, input.errorMessage ?? null, now],
    });

    const row = result.rows[0];
    return row ? rowToToolCall(row) : undefined;
  }

  async recordRuntimeHook(input: {
    id?: string;
    agentRunId?: string;
    hookEventName: NativeRuntimeHookEventName;
    decision: NativeRuntimeHookDecision;
    payload?: JsonObject;
    result?: JsonObject;
  }): Promise<NativeRuntimeHookRecord> {
    const now = new Date().toISOString();
    const result = await this.query<RuntimeHookRow>({
      text: `
        insert into agent_runtime_hooks (
          id, agent_run_id, hook_event_name, decision, payload, result, created_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
        returning id, agent_run_id, hook_event_name, decision, payload, result, created_at
      `,
      values: [
        input.id ?? `agent_hook_${randomUUID()}`,
        input.agentRunId ?? null,
        input.hookEventName,
        input.decision,
        stringifyJson(input.payload ?? {}),
        stringifyJson(input.result ?? {}),
        now,
      ],
    });

    return rowToRuntimeHook(requiredRow(result.rows[0], "runtime hook insert failed"));
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    if (!poolPromise) return;
    const pool = await poolPromise;
    await pool.end();
  }

  private async query<Row = Record<string, unknown>>(
    query: PostgresAutomationQuery,
  ): Promise<PostgresAutomationQueryResult<Row>> {
    if (this.queryRunner) return this.queryRunner<Row>(query);
    const pool = await this.pool();
    const result = await pool.query<Row>(query.text, query.values);
    return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
  }

  private pool(): Promise<PgPool> {
    this.poolPromise ??= createPool(this.config);
    return this.poolPromise;
  }
}

export class InMemoryNativeAgentStore implements NativeAgentStore {
  readonly automationRuns = new Map<string, AutomationRun>();
  readonly agentRuns = new Map<string, NativeAgentRun>();
  readonly events = new Map<string, NativeAgentRunEvent[]>();
  readonly toolCalls = new Map<string, NativeAgentToolCall>();
  readonly hooks: NativeRuntimeHookRecord[] = [];

  seedAutomationRun(run: AutomationRun): void {
    this.automationRuns.set(run.id, run);
  }

  async claimAutomationRun(input: ClaimAutomationRunInput = {}): Promise<NativeAgentRun | undefined> {
    const candidate = input.automationRunId
      ? this.automationRuns.get(input.automationRunId)
      : Array.from(this.automationRuns.values()).find((run) => run.status === "queued");
    if (!candidate || candidate.status !== "queued") return undefined;

    candidate.status = "running";
    candidate.startedAt ??= new Date().toISOString();
    const workflowId = input.workflowId ?? workflowIdFromAutomationRun(candidate);
    const run = await this.createAgentRun({
      owner: { tenantId: candidate.tenantId, userId: candidate.userId },
      automationRunId: candidate.id,
      workspaceSessionId: input.workspaceSessionId ?? candidate.workspaceSessionId,
      workflowId,
      status: "running",
      permissionProfile: input.permissionProfile ?? "workspace_write",
      input: input.input ?? {
        automationRunId: candidate.id,
        metadata: candidate.metadata,
        result: candidate.result,
      },
    });
    return run;
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<NativeAgentRun> {
    const now = new Date().toISOString();
    const run: NativeAgentRun = {
      id: input.id ?? `agent_run_${randomUUID()}`,
      tenantId: input.owner.tenantId,
      userId: input.owner.userId,
      automationRunId: input.automationRunId,
      workspaceSessionId: input.workspaceSessionId,
      workflowId: input.workflowId,
      status: input.status ?? "queued",
      attempt: input.attempt ?? 1,
      permissionProfile: input.permissionProfile ?? "workspace_write",
      input: input.input ?? {},
      result: {},
      createdAt: now,
      claimedAt: input.status === "queued" ? undefined : now,
      startedAt: input.status === "running" || input.status === "waiting_input" ? now : undefined,
      updatedAt: now,
    };
    this.agentRuns.set(run.id, run);
    this.events.set(run.id, []);
    return run;
  }

  async getAgentRun(id: string, owner?: WorkspaceIdentity): Promise<NativeAgentRun | undefined> {
    const run = this.agentRuns.get(id);
    if (!run) return undefined;
    if (owner && (run.tenantId !== owner.tenantId || run.userId !== owner.userId)) return undefined;
    return run;
  }

  async getAgentRunForAutomationRun(automationRunId: string): Promise<NativeAgentRun | undefined> {
    return Array.from(this.agentRuns.values()).find((run) => run.automationRunId === automationRunId);
  }

  async listAgentRuns(input: {
    owner?: WorkspaceIdentity;
    status?: NativeAgentRunStatus;
    limit?: number;
  } = {}): Promise<NativeAgentRun[]> {
    return Array.from(this.agentRuns.values())
      .filter((run) => !input.owner || (run.tenantId === input.owner.tenantId && run.userId === input.owner.userId))
      .filter((run) => !input.status || run.status === input.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit(input.limit));
  }

  async appendRunEvent(input: {
    agentRunId: string;
    type: string;
    payload?: JsonObject;
    id?: string;
  }): Promise<NativeAgentRunEvent> {
    const events = this.events.get(input.agentRunId);
    if (!events) throw new Error(`agent run not found: ${input.agentRunId}`);
    const event: NativeAgentRunEvent = {
      id: input.id ?? `agent_evt_${randomUUID()}`,
      agentRunId: input.agentRunId,
      seq: events.length + 1,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    };
    events.push(event);
    return event;
  }

  async readRunEvents(input: ReadAgentRunEventsInput): Promise<NativeAgentRunEvent[]> {
    return (this.events.get(input.agentRunId) ?? [])
      .filter((event) => event.seq > (input.afterSeq ?? 0))
      .slice(0, boundedLimit(input.maxEvents));
  }

  async finishAgentRun(input: FinishAgentRunInput): Promise<NativeAgentRun | undefined> {
    const run = this.agentRuns.get(input.agentRunId);
    if (!run) return undefined;
    const now = new Date().toISOString();
    run.status = input.status;
    run.result = input.result ?? {};
    run.errorCode = input.errorCode;
    run.errorMessage = input.errorMessage;
    run.finishedAt = now;
    run.updatedAt = now;
    if (run.automationRunId) {
      const automationRun = this.automationRuns.get(run.automationRunId);
      if (automationRun) {
        automationRun.status = automationStatusForAgentStatus(run.status);
        automationRun.result = run.result;
        automationRun.errorCode = run.errorCode;
        automationRun.errorMessage = run.errorMessage;
        automationRun.finishedAt = now;
      }
    }
    return run;
  }

  async setAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<NativeAgentRun | undefined> {
    const run = this.agentRuns.get(input.agentRunId);
    if (!run || isTerminalNativeAgentRunStatus(run.status)) return undefined;
    const now = new Date().toISOString();
    run.status = input.status;
    run.result = input.result ?? run.result;
    run.errorCode = input.errorCode;
    run.errorMessage = input.errorMessage;
    if (input.status === "claiming" || input.status === "running" || input.status === "waiting_input") run.claimedAt ??= now;
    if (input.status === "running" || input.status === "waiting_input") run.startedAt ??= now;
    run.updatedAt = now;
    if (run.automationRunId) {
      const automationRun = this.automationRuns.get(run.automationRunId);
      if (automationRun) {
        automationRun.status = automationStatusForAgentStatus(run.status);
        automationRun.result = run.result;
        automationRun.errorCode = run.errorCode;
        automationRun.errorMessage = run.errorMessage;
      }
    }
    return run;
  }

  async cancelAgentRun(input: { agentRunId: string; reason?: string }): Promise<NativeAgentRun | undefined> {
    await this.appendRunEvent({
      agentRunId: input.agentRunId,
      type: "run.cancel_requested",
      payload: { reason: input.reason ?? null },
    });
    return this.finishAgentRun({
      agentRunId: input.agentRunId,
      status: "cancelled",
      errorCode: "AGENT_RUN_CANCELLED",
      errorMessage: input.reason ?? "Native agent run was cancelled.",
    });
  }

  async recordToolCallStart(input: {
    id?: string;
    agentRunId: string;
    toolName: string;
    risk?: NativeAgentToolRisk;
    input?: JsonObject;
  }): Promise<NativeAgentToolCall> {
    const call: NativeAgentToolCall = {
      id: input.id ?? `agent_tool_${randomUUID()}`,
      agentRunId: input.agentRunId,
      toolName: input.toolName,
      status: "running",
      risk: input.risk ?? "low",
      input: input.input ?? {},
      result: {},
      startedAt: new Date().toISOString(),
    };
    this.toolCalls.set(call.id, call);
    return call;
  }

  async finishToolCall(input: {
    id: string;
    status: Exclude<NativeAgentToolCallStatus, "running">;
    result?: JsonObject;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<NativeAgentToolCall | undefined> {
    const call = this.toolCalls.get(input.id);
    if (!call) return undefined;
    call.status = input.status;
    call.result = input.result ?? {};
    call.errorCode = input.errorCode;
    call.errorMessage = input.errorMessage;
    call.finishedAt = new Date().toISOString();
    return call;
  }

  async recordRuntimeHook(input: {
    id?: string;
    agentRunId?: string;
    hookEventName: NativeRuntimeHookEventName;
    decision: NativeRuntimeHookDecision;
    payload?: JsonObject;
    result?: JsonObject;
  }): Promise<NativeRuntimeHookRecord> {
    const hook: NativeRuntimeHookRecord = {
      id: input.id ?? `agent_hook_${randomUUID()}`,
      agentRunId: input.agentRunId,
      hookEventName: input.hookEventName,
      decision: input.decision,
      payload: input.payload ?? {},
      result: input.result ?? {},
      createdAt: new Date().toISOString(),
    };
    this.hooks.push(hook);
    return hook;
  }
}

export function isTerminalNativeAgentRunStatus(status: NativeAgentRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

export function automationStatusForAgentStatus(status: NativeAgentRunStatus): AutomationRunStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "timed_out":
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

export function workflowIdFromAutomationRun(run: Pick<AutomationRun, "metadata">): string {
  const explicit = stringJson(run.metadata.workflowId);
  if (explicit) return explicit;
  return run.metadata.provider === "github" ? "github-pr-review" : "manual";
}

function rowToAgentRun(row: AgentRunRow): NativeAgentRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    automationRunId: row.automation_run_id ?? undefined,
    workspaceSessionId: row.workspace_session_id ?? undefined,
    workflowId: row.workflow_id,
    status: nativeAgentRunStatus(row.status),
    attempt: row.attempt,
    permissionProfile: nativePermissionProfile(row.permission_profile),
    input: jsonObject(row.input),
    result: jsonObject(row.result),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: toIsoString(row.created_at),
    claimedAt: row.claimed_at ? toIsoString(row.claimed_at) : undefined,
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToRunEvent(row: AgentRunEventRow): NativeAgentRunEvent {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    seq: row.seq,
    type: row.event_type,
    payload: jsonObject(row.payload),
    createdAt: toIsoString(row.created_at),
  };
}

function rowToToolCall(row: AgentToolCallRow): NativeAgentToolCall {
  return {
    id: row.id,
    agentRunId: row.agent_run_id,
    toolName: row.tool_name,
    status: nativeToolCallStatus(row.status),
    risk: nativeToolRisk(row.risk),
    input: jsonObject(row.input),
    result: jsonObject(row.result),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: toIsoString(row.started_at),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
  };
}

function rowToRuntimeHook(row: RuntimeHookRow): NativeRuntimeHookRecord {
  return {
    id: row.id,
    agentRunId: row.agent_run_id ?? undefined,
    hookEventName: nativeRuntimeHookEventName(row.hook_event_name),
    decision: nativeRuntimeHookDecision(row.decision),
    payload: jsonObject(row.payload),
    result: jsonObject(row.result),
    createdAt: toIsoString(row.created_at),
  };
}

function nativeAgentRunStatus(value: string): NativeAgentRunStatus {
  if (
    value === "queued" ||
    value === "claiming" ||
    value === "running" ||
    value === "waiting_input" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed_out"
  ) return value;
  throw new Error(`Invalid native agent run status: ${value}`);
}

function nativePermissionProfile(value: string): NativeAgentPermissionProfile {
  if (value === "read_only" || value === "workspace_write" || value === "trusted_local") return value;
  throw new Error(`Invalid native agent permission profile: ${value}`);
}

function nativeToolRisk(value: string): NativeAgentToolRisk {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Invalid native agent tool risk: ${value}`);
}

function nativeToolCallStatus(value: string): NativeAgentToolCallStatus {
  if (value === "running" || value === "succeeded" || value === "failed" || value === "blocked") return value;
  throw new Error(`Invalid native agent tool call status: ${value}`);
}

function nativeRuntimeHookEventName(value: string): NativeRuntimeHookEventName {
  if (value === "PreToolUse" || value === "PostToolUse" || value === "PermissionRequest" || value === "PostCompact" || value === "Stop") return value;
  throw new Error(`Invalid native runtime hook event: ${value}`);
}

function nativeRuntimeHookDecision(value: string): NativeRuntimeHookDecision {
  if (value === "allow" || value === "block" || value === "ask" || value === "deny" || value === "audit_only") return value;
  throw new Error(`Invalid native runtime hook decision: ${value}`);
}

function boundedLimit(value: number | undefined): number {
  if (!value) return 100;
  return Math.max(1, Math.min(Math.floor(value), 500));
}

function stringifyJson(value: JsonObject): string {
  return JSON.stringify(value);
}

function jsonObject(value: unknown): JsonObject {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return jsonObject(parsed);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) return value as JsonObject;
  return {};
}

function stringJson(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (!row) throw new Error(message);
  return row;
}

async function createPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace-native-agent",
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
      throw new Error(
        "Native agent store requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
