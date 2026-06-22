import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";
import {
  AutomationIdempotencyConflictError,
  AutomationStoreError,
  PostgresAutomationStore,
  type AutomationEvent,
  type AutomationEventRecordResult,
  type AutomationRun,
  type AutomationSource,
  type CreateAutomationRunInput,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type RecordAutomationEventInput,
} from "./postgres-automation-store.js";

const AUTOMATION_TRIGGER_ROUTE = "/api/automation/triggers/:triggerId/fire";
const JSON_BODY_LIMIT = "256kb";
const TRIGGER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:/=-]{1,200}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_TOKEN_LENGTH = 4096;
const MAX_TEXT_LENGTH = 20_000;
const MAX_CONVERSATION_KEY_LENGTH = 500;
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_LENGTH = 128;
const MAX_METADATA_STRING_LENGTH = 2_000;
const WORKSPACE_HINT_KEYS = [
  "repository",
  "branch",
  "rootLabel",
  "workspaceSessionId",
  "devspaceConversationId",
] as const;

export interface AutomationAcceptedResponse {
  automationRunId: string;
  automationEventId: string;
  status: "queued" | "duplicate";
  duplicate: boolean;
  dedupeGuaranteed: boolean;
  conversationKey?: string;
  createdAt: string;
}

export interface AutomationErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
    retryable: boolean;
  };
}

export type AutomationTriggerResponse = AutomationAcceptedResponse | AutomationErrorResponse;

export interface AutomationRouteRegistration {
  close(): Promise<void>;
}

export interface AutomationTriggerStore {
  getApiTriggerSourceForToken(input: {
    triggerId: string;
    tokenHash: string;
  }): Promise<AutomationSource | undefined>;
  recordEvent(input: RecordAutomationEventInput): Promise<AutomationEventRecordResult>;
  getRunForEvent(eventId: string, owner: WorkspaceIdentity): Promise<AutomationRun | undefined>;
  createRun(input: CreateAutomationRunInput): Promise<AutomationRun>;
  close?(): Promise<void>;
}

export interface FireAutomationTriggerInput {
  store: AutomationTriggerStore | undefined;
  triggerId: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
  requestId?: string;
}

export interface FireAutomationTriggerResult {
  statusCode: number;
  body: AutomationTriggerResponse;
}

interface NormalizedTriggerBody {
  sourceEventId?: string;
  text?: string;
  payload?: JsonValue;
  conversationKey?: string;
  workspaceHint?: JsonObject;
  metadata: JsonObject;
}

class AutomationApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutomationApiHttpError";
  }
}

export function registerAutomationApiRoutes(
  app: Express,
  config: Pick<ServerConfig, "database">,
): AutomationRouteRegistration {
  const store = isPostgresDatabaseConfig(config.database)
    ? new PostgresAutomationStore(config.database)
    : undefined;

  app.post(AUTOMATION_TRIGGER_ROUTE, jsonBodyParser, async (request, response) => {
    const requestId = request.get("x-request-id")?.trim() || randomUUID();
    response.setHeader("X-Request-Id", requestId);

    const result = await fireAutomationTrigger({
      store,
      triggerId: routeParam(request.params.triggerId),
      authorization: request.get("authorization"),
      idempotencyKey: request.get("idempotency-key"),
      body: request.body,
      requestId,
    });

    response.status(result.statusCode).json(result.body);
  });

  return {
    async close(): Promise<void> {
      await store?.close?.();
    },
  };
}

export async function fireAutomationTrigger(
  input: FireAutomationTriggerInput,
): Promise<FireAutomationTriggerResult> {
  const requestId = input.requestId || randomUUID();

  try {
    if (!input.store) {
      throw new AutomationApiHttpError(
        503,
        "AUTOMATION_STORE_UNAVAILABLE",
        "Automation triggers require DEVSPACE_DATABASE_PROVIDER=postgres.",
        true,
      );
    }

    const triggerId = normalizeTriggerId(input.triggerId);
    const sourceToken = parseBearerToken(input.authorization);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const body = normalizeTriggerBody(input.body);
    const tokenHash = automationSourceTokenHash(sourceToken);
    const source = await input.store.getApiTriggerSourceForToken({ triggerId, tokenHash });

    if (!source) {
      throw new AutomationApiHttpError(
        401,
        "AUTOMATION_TOKEN_INVALID",
        "Missing or invalid automation source token.",
        false,
      );
    }
    if (source.status !== "enabled") {
      throw new AutomationApiHttpError(
        403,
        "AUTOMATION_SOURCE_DISABLED",
        "Automation source is disabled.",
        false,
      );
    }

    const owner = { tenantId: source.tenantId, userId: source.userId };
    const requestFingerprint = automationRequestFingerprint({
      triggerId,
      idempotencyKey,
      body,
    });
    const record = await input.store.recordEvent({
      owner,
      id: `auto_evt_${randomUUID()}`,
      sourceId: source.id,
      sourceEventId: body.sourceEventId,
      idempotencyKey,
      requestFingerprint,
      eventType: "automation.trigger.fire",
      payload: triggerEventPayload(body),
      metadata: {
        ...body.metadata,
        requestId,
        triggerId,
      },
    });
    const run = await getOrCreateRunForEvent(input.store, owner, record.event, body);

    return {
      statusCode: 202,
      body: {
        automationRunId: run.id,
        automationEventId: record.event.id,
        status: record.outcome === "duplicate" ? "duplicate" : "queued",
        duplicate: record.outcome === "duplicate",
        dedupeGuaranteed: true,
        ...(body.conversationKey ? { conversationKey: body.conversationKey } : {}),
        createdAt: run.createdAt,
      },
    };
  } catch (error) {
    return automationErrorResult(error, requestId);
  }
}

export function automationSourceTokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function jsonBodyParser(request: Request, response: Response, next: NextFunction): void {
  express.json({ limit: JSON_BODY_LIMIT, type: ["application/json", "application/*+json"] })(
    request,
    response,
    (error) => {
      if (!error) {
        next();
        return;
      }

      const statusCode = jsonParserStatusCode(error);
      const code = statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "AUTOMATION_PAYLOAD_INVALID";
      const message = statusCode === 413
        ? "Automation trigger request body exceeds the 256 KiB limit."
        : "Automation trigger request body must be valid JSON.";
      const requestId = request.get("x-request-id")?.trim() || randomUUID();
      response.setHeader("X-Request-Id", requestId);
      response.status(statusCode).json(errorResponse(code, message, requestId, statusCode >= 500));
    },
  );
}

function jsonParserStatusCode(error: unknown): number {
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

async function getOrCreateRunForEvent(
  store: AutomationTriggerStore,
  owner: WorkspaceIdentity,
  event: AutomationEvent,
  body: NormalizedTriggerBody,
): Promise<AutomationRun> {
  const existing = await store.getRunForEvent(event.id, owner);
  if (existing) return existing;

  const createInput: CreateAutomationRunInput = {
    owner,
    id: automationRunIdForEvent(event.id),
    eventId: event.id,
    status: "queued",
    metadata: {
      sourceEventId: event.sourceEventId ?? null,
      ...(body.conversationKey ? { conversationKey: body.conversationKey } : {}),
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

function normalizeTriggerId(value: string): string {
  const triggerId = value.trim();
  if (!TRIGGER_ID_PATTERN.test(triggerId)) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_TRIGGER_INVALID",
      "triggerId must be 1-128 characters and contain only letters, numbers, '.', '_', ':', or '-'.",
      false,
    );
  }
  return triggerId;
}

function parseBearerToken(value: string | undefined): string {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new AutomationApiHttpError(
      401,
      "AUTOMATION_TOKEN_INVALID",
      "Missing or invalid automation source token.",
      false,
    );
  }
  return token;
}

function normalizeIdempotencyKey(value: string | undefined): string {
  const idempotencyKey = value?.trim();
  if (!idempotencyKey) {
    throw new AutomationApiHttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required for automation trigger requests.",
      false,
    );
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AutomationApiHttpError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      `Idempotency-Key must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer.`,
      false,
    );
  }
  return idempotencyKey;
}

function normalizeTriggerBody(value: unknown): NormalizedTriggerBody {
  const body = plainObject(value, "request body");
  const sourceEventId = optionalExternalId(body.eventId, "eventId");
  const text = optionalText(body.text);
  const payload = optionalJsonValue(body.payload, "payload");
  const conversationKey = optionalBoundedString(
    body.conversationKey,
    "conversationKey",
    MAX_CONVERSATION_KEY_LENGTH,
  );
  const workspaceHint = optionalWorkspaceHint(body.workspaceHint);
  const metadata = optionalMetadata(body.metadata);

  if (text === undefined && payload === undefined) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      "Automation trigger request requires at least one of text or payload.",
      false,
    );
  }

  return {
    ...(sourceEventId ? { sourceEventId } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(conversationKey ? { conversationKey } : {}),
    ...(workspaceHint ? { workspaceHint } : {}),
    metadata,
  };
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      "text must be a string when provided.",
      false,
    );
  }
  const text = value.trim();
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `text must be 1-${MAX_TEXT_LENGTH} characters when provided.`,
      false,
    );
  }
  return text;
}

function optionalExternalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = optionalBoundedString(value, field, 200);
  if (!normalized) return undefined;
  if (!EXTERNAL_ID_PATTERN.test(normalized)) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `${field} contains unsupported characters.`,
      false,
      { field },
    );
  }
  return normalized;
}

function optionalBoundedString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `${field} must be a string when provided.`,
      false,
      { field },
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `${field} must be 1-${maxLength} characters when provided.`,
      false,
      { field },
    );
  }
  return normalized;
}

function optionalJsonValue(value: unknown, field: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (!isJsonValue(value)) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `${field} must be JSON-serializable.`,
      false,
      { field },
    );
  }
  return value;
}

function optionalWorkspaceHint(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const raw = plainObject(value, "workspaceHint");
  const hint: JsonObject = {};

  for (const key of WORKSPACE_HINT_KEYS) {
    const fieldValue = raw[key];
    if (fieldValue === undefined) continue;
    hint[key] = optionalBoundedString(fieldValue, `workspaceHint.${key}`, 500) ?? null;
  }

  return Object.keys(hint).length > 0 ? hint : undefined;
}

function optionalMetadata(value: unknown): JsonObject {
  if (value === undefined) return {};
  const raw = plainObject(value, "metadata");
  const entries = Object.entries(raw);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new AutomationApiHttpError(
      400,
      "AUTOMATION_PAYLOAD_INVALID",
      `metadata must contain ${MAX_METADATA_KEYS} keys or fewer.`,
      false,
    );
  }

  const metadata: JsonObject = {};
  for (const [key, fieldValue] of entries) {
    if (!key || key.length > MAX_METADATA_KEY_LENGTH) {
      throw new AutomationApiHttpError(
        400,
        "AUTOMATION_PAYLOAD_INVALID",
        `metadata keys must be 1-${MAX_METADATA_KEY_LENGTH} characters.`,
        false,
      );
    }
    metadata[key] = metadataValue(fieldValue, key);
  }
  return metadata;
}

function metadataValue(value: unknown, key: string): JsonPrimitive {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_METADATA_STRING_LENGTH) {
      throw new AutomationApiHttpError(
        400,
        "AUTOMATION_PAYLOAD_INVALID",
        `metadata.${key} must be ${MAX_METADATA_STRING_LENGTH} characters or fewer.`,
        false,
      );
    }
    return value;
  }
  throw new AutomationApiHttpError(
    400,
    "AUTOMATION_PAYLOAD_INVALID",
    `metadata.${key} must be a scalar JSON value.`,
    false,
    { field: `metadata.${key}` },
  );
}

function triggerEventPayload(body: NormalizedTriggerBody): JsonObject {
  return {
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.payload !== undefined ? { payload: body.payload } : {}),
    ...(body.conversationKey ? { conversationKey: body.conversationKey } : {}),
    ...(body.workspaceHint ? { workspaceHint: body.workspaceHint } : {}),
  };
}

function automationRequestFingerprint(input: {
  triggerId: string;
  idempotencyKey: string;
  body: NormalizedTriggerBody;
}): string {
  const canonical = stableStringify({
    triggerId: input.triggerId,
    idempotencyKey: input.idempotencyKey,
    sourceEventId: input.body.sourceEventId ?? null,
    text: input.body.text ?? null,
    payload: input.body.payload ?? null,
    conversationKey: input.body.conversationKey ?? null,
    workspaceHint: input.body.workspaceHint ?? null,
    metadata: input.body.metadata,
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

function automationErrorResult(error: unknown, requestId: string): FireAutomationTriggerResult {
  if (error instanceof AutomationApiHttpError) {
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
        "Idempotency-Key or eventId was reused with a different request fingerprint.",
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
    body: errorResponse("AUTOMATION_TRIGGER_FAILED", "Automation trigger request failed.", requestId, true),
  };
}

function errorResponse(
  code: string,
  message: string,
  requestId: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): AutomationErrorResponse {
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

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new AutomationApiHttpError(
    400,
    "AUTOMATION_PAYLOAD_INVALID",
    `${field} must be a JSON object.`,
    false,
    { field },
  );
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
