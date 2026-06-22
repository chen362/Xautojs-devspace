import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { isPostgresDatabaseConfig, type PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  AutomationIdempotencyConflictError,
  AutomationStoreError,
  PostgresAutomationStore,
  PostgresAutomationStoreQueryError,
  type AutomationEvent,
  type AutomationEventRecordResult,
  type AutomationRun,
  type AutomationSource,
  type CreateAutomationRunInput,
  type JsonObject,
  type JsonValue,
  type RecordAutomationEventInput,
} from "./postgres-automation-store.js";

const GITHUB_WEBHOOK_ROUTE = "/api/automation/github/webhooks/:sourceId";
const RAW_BODY_LIMIT = "1mb";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const GITHUB_EVENT_PATTERN = /^[A-Za-z0-9_]{1,100}$/;
const GITHUB_DELIVERY_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
const ENV_SECRET_REF_PATTERN = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const MAX_SECRET_LENGTH = 4096;
const MAX_SIGNATURE_LENGTH = 200;
const MAX_EVENT_TYPE_SEGMENT_LENGTH = 100;

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

export interface GithubWebhookAcceptedResponse {
  automationRunId: string;
  automationEventId: string;
  status: "queued" | "duplicate";
  duplicate: boolean;
  dedupeGuaranteed: boolean;
  githubEvent: string;
  githubDelivery: string;
  createdAt: string;
}

export interface GithubWebhookErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    retryable: boolean;
  };
}

export type GithubWebhookResponse = GithubWebhookAcceptedResponse | GithubWebhookErrorResponse;

export interface GithubWebhookRouteRegistration {
  close(): Promise<void>;
}

export interface GithubWebhookStore {
  getGithubWebhookSource(id: string): Promise<AutomationSource | undefined>;
  recordEvent(input: RecordAutomationEventInput): Promise<AutomationEventRecordResult>;
  getRunForEvent(eventId: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined>;
  createRun(input: CreateAutomationRunInput): Promise<AutomationRun>;
  close?(): Promise<void>;
}

export interface HandleGithubWebhookInput {
  store: GithubWebhookStore | undefined;
  sourceId: string;
  githubEvent: string | undefined;
  githubDelivery: string | undefined;
  githubSignature256: string | undefined;
  rawBody: Buffer | undefined;
  requestId?: string;
}

export interface HandleGithubWebhookResult {
  statusCode: number;
  body: GithubWebhookResponse;
}

interface GithubWebhookRouteOptions {
  store?: GithubWebhookStore;
}

interface NormalizedGithubWebhook {
  sourceId: string;
  githubEvent: string;
  githubDelivery: string;
  action?: string;
  eventType: string;
  payload: JsonObject;
  metadata: JsonObject;
  requestFingerprint: string;
}

class GithubWebhookHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GithubWebhookHttpError";
  }
}

class PostgresGithubWebhookStore implements GithubWebhookStore {
  private readonly automationStore: PostgresAutomationStore;
  private poolPromise: Promise<PgPool> | undefined;

  constructor(private readonly config: PostgresDatabaseConfig) {
    this.automationStore = new PostgresAutomationStore(config);
  }

  async getGithubWebhookSource(id: string): Promise<AutomationSource | undefined> {
    const result = await this.query<AutomationSourceRow>(
      `
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
          and kind = 'github_webhook'
        limit 1
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? rowToAutomationSource(row) : undefined;
  }

  async recordEvent(input: RecordAutomationEventInput): Promise<AutomationEventRecordResult> {
    return this.automationStore.recordEvent(input);
  }

  async getRunForEvent(eventId: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined> {
    return this.automationStore.getRunForEvent(eventId, owner);
  }

  async createRun(input: CreateAutomationRunInput): Promise<AutomationRun> {
    return this.automationStore.createRun(input);
  }

  async close(): Promise<void> {
    const poolPromise = this.poolPromise;
    this.poolPromise = undefined;
    await Promise.all([
      this.automationStore.close(),
      poolPromise ? poolPromise.then((pool) => pool.end()) : Promise.resolve(),
    ]);
  }

  private async query<Row>(text: string, values: QueryValue[]): Promise<PgPoolResult<Row>> {
    const pool = await this.pool();
    return pool.query<Row>(text, values);
  }

  private pool(): Promise<PgPool> {
    this.poolPromise ??= createPool(this.config);
    return this.poolPromise;
  }
}

export function registerGithubWebhookRoutes(
  app: Express,
  config: Pick<ServerConfig, "database">,
  options: GithubWebhookRouteOptions = {},
): GithubWebhookRouteRegistration {
  const store = options.store ?? (isPostgresDatabaseConfig(config.database)
    ? new PostgresGithubWebhookStore(config.database)
    : undefined);
  const ownsStore = !options.store;

  app.post(GITHUB_WEBHOOK_ROUTE, rawBodyParser, async (request, response) => {
    const requestId = request.get("x-request-id")?.trim() || randomUUID();
    response.setHeader("X-Request-Id", requestId);

    const result = await handleGithubWebhook({
      store,
      sourceId: routeParam(request.params.sourceId),
      githubEvent: request.get("x-github-event"),
      githubDelivery: request.get("x-github-delivery"),
      githubSignature256: request.get("x-hub-signature-256"),
      rawBody: Buffer.isBuffer(request.body) ? request.body : undefined,
      requestId,
    });

    response.status(result.statusCode).json(result.body);
  });

  return {
    async close(): Promise<void> {
      if (ownsStore) await store?.close?.();
    },
  };
}

export async function handleGithubWebhook(
  input: HandleGithubWebhookInput,
): Promise<HandleGithubWebhookResult> {
  const requestId = input.requestId || randomUUID();

  try {
    if (!input.store) {
      throw new GithubWebhookHttpError(
        503,
        "AUTOMATION_STORE_UNAVAILABLE",
        "GitHub webhooks require DEVSPACE_DATABASE_PROVIDER=postgres.",
        true,
      );
    }

    const sourceId = normalizeSourceId(input.sourceId);
    const source = await input.store.getGithubWebhookSource(sourceId);
    if (!source) {
      throw new GithubWebhookHttpError(
        404,
        "GITHUB_WEBHOOK_SOURCE_NOT_FOUND",
        "GitHub webhook automation source was not found.",
        false,
      );
    }
    if (source.status !== "enabled") {
      throw new GithubWebhookHttpError(
        403,
        "GITHUB_WEBHOOK_SOURCE_DISABLED",
        "GitHub webhook automation source is disabled.",
        false,
      );
    }

    const rawBody = requiredRawBody(input.rawBody);
    const secret = resolveGithubWebhookSecret(source.secretRef);
    verifyGithubSignature(input.githubSignature256, rawBody, secret);

    const webhook = normalizeGithubWebhook({
      sourceId,
      githubEvent: input.githubEvent,
      githubDelivery: input.githubDelivery,
      rawBody,
    });
    const owner = { tenantId: source.tenantId, userId: source.userId };
    const record = await input.store.recordEvent({
      owner,
      id: `auto_evt_${randomUUID()}`,
      sourceId: source.id,
      sourceEventId: webhook.githubDelivery,
      idempotencyKey: `github:${webhook.githubDelivery}`,
      requestFingerprint: webhook.requestFingerprint,
      eventType: webhook.eventType,
      payload: webhook.payload,
      metadata: {
        ...webhook.metadata,
        requestId,
      },
    });
    const run = await getOrCreateRunForEvent(input.store, owner, record.event, webhook);

    return {
      statusCode: 202,
      body: {
        automationRunId: run.id,
        automationEventId: record.event.id,
        status: record.outcome === "duplicate" ? "duplicate" : "queued",
        duplicate: record.outcome === "duplicate",
        dedupeGuaranteed: true,
        githubEvent: webhook.githubEvent,
        githubDelivery: webhook.githubDelivery,
        createdAt: run.createdAt,
      },
    };
  } catch (error) {
    return githubWebhookErrorResult(error, requestId);
  }
}

function rawBodyParser(request: Request, response: Response, next: NextFunction): void {
  express.raw({ limit: RAW_BODY_LIMIT, type: ["application/json", "application/*+json"] })(
    request,
    response,
    (error) => {
      if (!error) {
        next();
        return;
      }

      const statusCode = rawParserStatusCode(error);
      const code = statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "GITHUB_WEBHOOK_PAYLOAD_INVALID";
      const message = statusCode === 413
        ? "GitHub webhook request body exceeds the 1 MiB limit."
        : "GitHub webhook request body must be valid raw JSON.";
      const requestId = request.get("x-request-id")?.trim() || randomUUID();
      response.setHeader("X-Request-Id", requestId);
      response.status(statusCode).json(errorResponse(code, message, requestId, statusCode >= 500));
    },
  );
}

function rawParserStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 413) return 413;
  }
  return 400;
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function requiredRawBody(value: Buffer | undefined): Buffer {
  if (value && value.length > 0) return value;
  throw new GithubWebhookHttpError(
    400,
    "GITHUB_WEBHOOK_PAYLOAD_INVALID",
    "GitHub webhook request body must be a non-empty JSON object.",
    false,
  );
}

function normalizeSourceId(value: string): string {
  const sourceId = value.trim();
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw new GithubWebhookHttpError(
      400,
      "GITHUB_WEBHOOK_SOURCE_INVALID",
      "sourceId must be 1-128 characters and contain only letters, numbers, '.', '_', ':', or '-'.",
      false,
    );
  }
  return sourceId;
}

function normalizeGithubWebhook(input: {
  sourceId: string;
  githubEvent: string | undefined;
  githubDelivery: string | undefined;
  rawBody: Buffer;
}): NormalizedGithubWebhook {
  const githubEvent = normalizeGithubEvent(input.githubEvent);
  const githubDelivery = normalizeGithubDelivery(input.githubDelivery);
  const payload = parseGithubPayload(input.rawBody);
  const action = optionalPayloadString(payload, "action", MAX_EVENT_TYPE_SEGMENT_LENGTH);
  const eventType = githubEventType(githubEvent, action);
  const metadata = githubMetadata({
    sourceId: input.sourceId,
    githubEvent,
    githubDelivery,
    action,
    payload,
  });
  const requestFingerprint = githubWebhookFingerprint({
    sourceId: input.sourceId,
    githubEvent,
    githubDelivery,
    payload,
  });

  return {
    sourceId: input.sourceId,
    githubEvent,
    githubDelivery,
    ...(action ? { action } : {}),
    eventType,
    payload,
    metadata,
    requestFingerprint,
  };
}

function normalizeGithubEvent(value: string | undefined): string {
  const event = value?.trim();
  if (!event || !GITHUB_EVENT_PATTERN.test(event)) {
    throw new GithubWebhookHttpError(
      400,
      "GITHUB_WEBHOOK_EVENT_INVALID",
      "X-GitHub-Event is required and must be a valid GitHub event name.",
      false,
    );
  }
  return event;
}

function normalizeGithubDelivery(value: string | undefined): string {
  const delivery = value?.trim();
  if (!delivery || !GITHUB_DELIVERY_PATTERN.test(delivery)) {
    throw new GithubWebhookHttpError(
      400,
      "GITHUB_WEBHOOK_DELIVERY_INVALID",
      "X-GitHub-Delivery is required and must be a valid delivery id.",
      false,
    );
  }
  return delivery;
}

function parseGithubPayload(rawBody: Buffer): JsonObject {
  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    return plainObject(parsed, "GitHub webhook payload");
  } catch (error) {
    if (error instanceof GithubWebhookHttpError) throw error;
    throw new GithubWebhookHttpError(
      400,
      "GITHUB_WEBHOOK_PAYLOAD_INVALID",
      "GitHub webhook request body must be valid JSON.",
      false,
    );
  }
}

function resolveGithubWebhookSecret(secretRef: string | undefined): string {
  const match = secretRef?.match(ENV_SECRET_REF_PATTERN);
  if (!match) {
    throw new GithubWebhookHttpError(
      503,
      "GITHUB_WEBHOOK_SECRET_UNAVAILABLE",
      "GitHub webhook sources require secretRef=env:VARIABLE_NAME.",
      true,
    );
  }

  const secret = process.env[match[1] ?? ""];
  if (!secret || secret.length > MAX_SECRET_LENGTH) {
    throw new GithubWebhookHttpError(
      503,
      "GITHUB_WEBHOOK_SECRET_UNAVAILABLE",
      "GitHub webhook secret environment variable is missing or invalid.",
      true,
    );
  }
  return secret;
}

function verifyGithubSignature(
  signatureHeader: string | undefined,
  rawBody: Buffer,
  secret: string,
): void {
  const signature = signatureHeader?.trim();
  if (!signature || signature.length > MAX_SIGNATURE_LENGTH || !signature.startsWith("sha256=")) {
    throw new GithubWebhookHttpError(
      401,
      "GITHUB_WEBHOOK_SIGNATURE_INVALID",
      "Missing or invalid X-Hub-Signature-256 header.",
      false,
    );
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(signature, "utf8");
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    throw new GithubWebhookHttpError(
      401,
      "GITHUB_WEBHOOK_SIGNATURE_INVALID",
      "GitHub webhook signature verification failed.",
      false,
    );
  }
}

async function getOrCreateRunForEvent(
  store: GithubWebhookStore,
  owner: WorkspaceIdentity,
  event: AutomationEvent,
  webhook: NormalizedGithubWebhook,
): Promise<AutomationRun> {
  const existing = await store.getRunForEvent(event.id, owner);
  if (existing) return existing;

  const createInput: CreateAutomationRunInput = {
    owner,
    id: automationRunIdForEvent(event.id),
    eventId: event.id,
    status: "queued",
    metadata: {
      provider: "github",
      githubEvent: webhook.githubEvent,
      githubDelivery: webhook.githubDelivery,
      ...(webhook.action ? { action: webhook.action } : {}),
    },
  };

  try {
    return await store.createRun(createInput);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const createdByConcurrentRequest = await store.getRunForEvent(event.id, owner);
    if (createdByConcurrentRequest) return createdByConcurrentRequest;
    throw error;
  }
}

function automationRunIdForEvent(eventId: string): string {
  return `auto_run_${eventId}`;
}

function githubEventType(githubEvent: string, action: string | undefined): string {
  const actionSegment = action ? eventTypeSegment(action) : undefined;
  return actionSegment ? `github.${githubEvent}.${actionSegment}` : `github.${githubEvent}`;
}

function eventTypeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, MAX_EVENT_TYPE_SEGMENT_LENGTH);
}

function githubMetadata(input: {
  sourceId: string;
  githubEvent: string;
  githubDelivery: string;
  action?: string;
  payload: JsonObject;
}): JsonObject {
  const repository = nestedString(input.payload, "repository", "full_name");
  const sender = nestedString(input.payload, "sender", "login");
  return {
    provider: "github",
    sourceId: input.sourceId,
    githubEvent: input.githubEvent,
    githubDelivery: input.githubDelivery,
    ...(input.action ? { action: input.action } : {}),
    ...(repository ? { repository } : {}),
    ...(sender ? { sender } : {}),
  };
}

function nestedString(value: JsonObject, objectKey: string, fieldKey: string): string | undefined {
  const nested = value[objectKey];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return undefined;
  const field = (nested as JsonObject)[fieldKey];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function optionalPayloadString(payload: JsonObject, key: string, maxLength: number): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

function githubWebhookFingerprint(input: {
  sourceId: string;
  githubEvent: string;
  githubDelivery: string;
  payload: JsonObject;
}): string {
  const canonical = stableStringify({
    sourceId: input.sourceId,
    githubEvent: input.githubEvent,
    githubDelivery: input.githubDelivery,
    payload: input.payload,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`)
    .join(",")}}`;
}

function githubWebhookErrorResult(error: unknown, requestId: string): HandleGithubWebhookResult {
  if (error instanceof GithubWebhookHttpError) {
    return {
      statusCode: error.statusCode,
      body: errorResponse(error.code, error.message, requestId, error.retryable, error.details),
    };
  }
  if (error instanceof AutomationIdempotencyConflictError) {
    return {
      statusCode: 409,
      body: errorResponse(
        "IDEMPOTENCY_CONFLICT",
        "GitHub delivery id was reused with a different request fingerprint.",
        requestId,
        false,
        { existingEventId: error.existingEventId },
      ),
    };
  }
  if (error instanceof AutomationStoreError) {
    const statusCode = error.code === "AUTOMATION_SOURCE_NOT_FOUND" ? 404 : 500;
    return {
      statusCode,
      body: errorResponse(error.code, error.message, requestId, statusCode >= 500),
    };
  }

  return {
    statusCode: 500,
    body: errorResponse("GITHUB_WEBHOOK_FAILED", "GitHub webhook request failed.", requestId, true),
  };
}

function errorResponse(
  code: string,
  message: string,
  requestId: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): GithubWebhookErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId,
      retryable,
    },
  };
}

function plainObject(value: unknown, field: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) {
    return value as JsonObject;
  }
  throw new GithubWebhookHttpError(
    400,
    "GITHUB_WEBHOOK_PAYLOAD_INVALID",
    `${field} must be a JSON object.`,
    false,
    { field },
  );
}

function rowToAutomationSource(row: AutomationSourceRow): AutomationSource {
  if (row.kind !== "github_webhook") {
    throw new AutomationStoreError("AUTOMATION_SOURCE_KIND_INVALID", `Invalid GitHub webhook source kind: ${row.kind}`);
  }
  if (row.status !== "enabled" && row.status !== "disabled") {
    throw new AutomationStoreError("AUTOMATION_SOURCE_STATUS_INVALID", `Invalid automation source status: ${row.status}`);
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    secretRef: row.secret_ref ?? undefined,
    tokenHash: row.token_hash ?? undefined,
    config: jsonObject(row.config),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
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

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function createPool(config: PostgresDatabaseConfig): Promise<PgPool> {
  const Pool = await importPgPool();
  return new Pool({
    connectionString: config.url,
    ssl: sslFor(config),
    application_name: "devspace-github-webhook",
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
        "GitHub webhook receiver requires the optional pg peer dependency. Install it next to DevSpace with: npm install pg",
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
