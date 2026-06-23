import express, { type Express, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import { PostgresNativeAgentStore, type NativeAgentRunStatus, type NativeAgentStore } from "./native-agent-store.js";
import { dispatchNativeAgentOnce } from "./native-agent-runtime.js";

const JSON_BODY_LIMIT = "64kb";
const ROUTE_PREFIX = "/api/native-agent";
const RUN_STATUSES = new Set<NativeAgentRunStatus>([
  "queued",
  "claiming",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export interface NativeAgentApiRegistration {
  close(): Promise<void>;
}

interface NativeAgentApiOptions {
  store?: NativeAgentStore;
  operatorToken?: string;
}

class NativeAgentApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeAgentApiError";
  }
}

export function registerNativeAgentApiRoutes(
  app: Express,
  config: ServerConfig,
  options: NativeAgentApiOptions = {},
): NativeAgentApiRegistration {
  const store = options.store ?? (isPostgresDatabaseConfig(config.database) ? new PostgresNativeAgentStore(config.database) : undefined);
  const ownsStore = !options.store;
  const operatorToken = options.operatorToken ?? process.env.DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN;
  const jsonBody = express.json({ limit: JSON_BODY_LIMIT, type: ["application/json", "application/*+json"] });

  app.get(`${ROUTE_PREFIX}/runs`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorToken);
      if (!store) throw unavailable();
      const runs = await store.listAgentRuns({
        status: optionalStatus(request.query.status),
        limit: optionalPositiveInt(request.query.limit, 100),
      });
      response.json({ runs, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/runs/:agentRunId`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorToken);
      if (!store) throw unavailable();
      const run = await store.getAgentRun(routeParam(request.params.agentRunId));
      if (!run) throw new NativeAgentApiError(404, "AGENT_RUN_NOT_FOUND", "Native agent run was not found.", false);
      response.json({ run, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/runs/:agentRunId/events`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorToken);
      if (!store) throw unavailable();
      const agentRunId = routeParam(request.params.agentRunId);
      const afterSeq = optionalPositiveInt(request.query.afterSeq, 0);
      const events = await store.readRunEvents({
        agentRunId,
        afterSeq,
        maxEvents: optionalPositiveInt(request.query.maxEvents, 100),
      });
      const nextSeq = events.length > 0 ? events[events.length - 1]!.seq + 1 : afterSeq + 1;
      response.json({ agentRunId, events, nextSeq, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/cancel`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorToken);
      if (!store) throw unavailable();
      const run = await store.cancelAgentRun({
        agentRunId: routeParam(request.params.agentRunId),
        reason: bodyString(request.body, "reason"),
      });
      if (!run) throw new NativeAgentApiError(404, "AGENT_RUN_NOT_FOUND", "Native agent run was not found.", false);
      response.json({ run, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/dispatch/once`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorToken);
      const result = await dispatchNativeAgentOnce(config, {
        automationRunId: bodyString(request.body, "automationRunId"),
        workspaceRoot: bodyString(request.body, "workspaceRoot"),
        workflowId: bodyString(request.body, "workflowId"),
        timeoutMs: bodyNumber(request.body, "timeoutMs"),
      });
      response.status(result.claimed ? 202 : 200).json({ ...result, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  return {
    async close(): Promise<void> {
      if (ownsStore) await store?.close?.();
    },
  };
}

function requireOperator(request: Request, operatorToken: string | undefined): void {
  if (!operatorToken) {
    throw new NativeAgentApiError(
      503,
      "NATIVE_AGENT_OPERATOR_TOKEN_UNAVAILABLE",
      "Set DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN to enable native agent operator APIs.",
      true,
    );
  }
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(token, operatorToken)) {
    throw new NativeAgentApiError(401, "NATIVE_AGENT_OPERATOR_TOKEN_INVALID", "Missing or invalid native agent operator token.", false);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requestIdFor(request: Request, response: Response): string {
  const requestId = request.get("x-request-id")?.trim() || randomUUID();
  response.setHeader("X-Request-Id", requestId);
  return requestId;
}

function sendError(response: Response, requestId: string, error: unknown): void {
  if (error instanceof NativeAgentApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        requestId,
        retryable: error.retryable,
      },
    });
    return;
  }
  response.status(500).json({
    error: {
      code: "NATIVE_AGENT_API_FAILED",
      message: "Native agent API request failed.",
      requestId,
      retryable: true,
    },
  });
}

function unavailable(): NativeAgentApiError {
  return new NativeAgentApiError(
    503,
    "NATIVE_AGENT_STORE_UNAVAILABLE",
    "Native agent APIs require DEVSPACE_DATABASE_PROVIDER=postgres.",
    true,
  );
}

function routeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function optionalStatus(value: unknown): NativeAgentRunStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && RUN_STATUSES.has(value as NativeAgentRunStatus)) return value as NativeAgentRunStatus;
  throw new NativeAgentApiError(400, "INVALID_AGENT_RUN_STATUS", "Native agent run status filter is invalid.", false);
}

function optionalPositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function bodyString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bodyNumber(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
