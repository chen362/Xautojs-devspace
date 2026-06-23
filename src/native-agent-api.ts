import express, { type Express, type Request, type Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ServerConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import { PostgresNativeAgentStore, type NativeAgentRunStatus, type NativeAgentStore, type NativeAgentToolRisk } from "./native-agent-store.js";
import { dispatchNativeAgentOnce, dispatchNativeAgentRunOnce } from "./native-agent-runtime.js";
import {
  createNativeAgentRetry,
  listNativeAgentApprovals,
  NativeAgentOperatorError,
  replayNativeAgentRun,
  requestNativeAgentApproval,
  resolveNativeAgentApproval,
  type NativeAgentApprovalDecision,
} from "./native-agent-operator.js";
import type { JsonObject, JsonValue } from "./postgres-automation-store.js";

const JSON_BODY_LIMIT = "64kb";
const ROUTE_PREFIX = "/api/native-agent";
const OPERATOR_CONSOLE_ROUTE = "/operator";
const OPERATOR_APP_MANIFEST_ENTRY = "operator-app.html";
const OPERATOR_SESSION_COOKIE = "devspace_operator_session";
const DEFAULT_OPERATOR_SESSION_TTL_SECONDS = 8 * 60 * 60;
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
  operatorSessionSecret?: string;
  operatorSessionTtlSeconds?: number;
}

interface OperatorAuthConfig {
  token?: string;
  sessionSecret?: string;
  sessionTtlSeconds: number;
  secureCookie: boolean;
}

interface OperatorAuthentication {
  method: "bearer" | "session";
  expiresAt?: string;
}

interface OperatorConsoleManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type OperatorConsoleManifest = Record<string, OperatorConsoleManifestEntry>;

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
  const operatorAuth: OperatorAuthConfig = {
    token: operatorToken,
    sessionSecret: options.operatorSessionSecret ?? process.env.DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_SECRET ?? operatorToken,
    sessionTtlSeconds: options.operatorSessionTtlSeconds ?? parseOperatorSessionTtl(process.env.DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS),
    secureCookie: publicBaseUrlIsHttps(config),
  };
  const jsonBody = express.json({ limit: JSON_BODY_LIMIT, type: ["application/json", "application/*+json"] });

  app.get(OPERATOR_CONSOLE_ROUTE, (_request, response) => {
    try {
      response.type("html").send(operatorConsoleHtml(config));
    } catch (error) {
      response.status(503).type("text/plain").send(
        error instanceof Error
          ? error.message
          : "Operator console assets are not available. Run npm run build.",
      );
    }
  });

  app.post(`${ROUTE_PREFIX}/operator/session`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      const token = bodyString(request.body, "token") ?? bearerToken(request);
      if (!operatorAuth.token) throw operatorTokenUnavailable();
      if (!token || !safeEqual(token, operatorAuth.token)) {
        throw new NativeAgentApiError(401, "NATIVE_AGENT_OPERATOR_TOKEN_INVALID", "Missing or invalid native agent operator token.", false);
      }
      const session = setOperatorSessionCookie(response, operatorAuth);
      response.status(201).json({
        session: {
          authenticated: true,
          method: "session",
          expiresAt: session.expiresAt,
        },
        requestId,
      });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/operator/session`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      const authentication = requireOperator(request, operatorAuth);
      response.json({
        session: {
          authenticated: true,
          method: authentication.method,
          expiresAt: authentication.expiresAt,
        },
        requestId,
      });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.delete(`${ROUTE_PREFIX}/operator/session`, async (_request, response) => {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    clearOperatorSessionCookie(response, operatorAuth);
    response.json({ session: { authenticated: false }, requestId });
  });

  app.get(`${ROUTE_PREFIX}/runs`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
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
      requireOperator(request, operatorAuth);
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
      requireOperator(request, operatorAuth);
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

  app.get(`${ROUTE_PREFIX}/runs/:agentRunId/replay`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      if (!store) throw unavailable();
      const replay = await replayNativeAgentRun(store, { agentRunId: routeParam(request.params.agentRunId) });
      response.json({ replay, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/cancel`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
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

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/retry`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      if (!store) throw unavailable();
      const retry = await createNativeAgentRetry(store, {
        agentRunId: routeParam(request.params.agentRunId),
        reason: bodyString(request.body, "reason"),
      });
      response.status(201).json({ retry, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.get(`${ROUTE_PREFIX}/runs/:agentRunId/approvals`, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      if (!store) throw unavailable();
      const approvals = await listNativeAgentApprovals(store, { agentRunId: routeParam(request.params.agentRunId) });
      response.json({ approvals, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/approvals`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      if (!store) throw unavailable();
      const approval = await requestNativeAgentApproval(store, {
        agentRunId: routeParam(request.params.agentRunId),
        title: bodyString(request.body, "title") ?? "Approval requested",
        message: bodyString(request.body, "message") ?? "Native agent approval requested.",
        risk: bodyRisk(request.body),
        request: bodyJsonObject(request.body, "request"),
        requestedBy: bodyString(request.body, "requestedBy"),
        expiresAt: bodyString(request.body, "expiresAt"),
      });
      response.status(201).json({ approval, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/approvals/:approvalId/resolve`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      if (!store) throw unavailable();
      const approval = await resolveNativeAgentApproval(store, {
        agentRunId: routeParam(request.params.agentRunId),
        approvalId: routeParam(request.params.approvalId),
        decision: bodyApprovalDecision(request.body),
        response: bodyJsonObject(request.body, "response") ?? responseFromMessage(request.body),
        resolvedBy: bodyString(request.body, "resolvedBy"),
      });
      response.json({ approval, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/runs/:agentRunId/resume`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      const result = await dispatchNativeAgentRunOnce(config, {
        agentRunId: routeParam(request.params.agentRunId),
        workspaceRoot: bodyString(request.body, "workspaceRoot"),
        timeoutMs: bodyNumber(request.body, "timeoutMs"),
        approvalTimeoutMs: bodyNumber(request.body, "approvalTimeoutMs"),
      }, store ? { store } : undefined);
      response.status(result.claimed ? 202 : 200).json({ ...result, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/dispatch/once`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      const result = await dispatchNativeAgentOnce(config, {
        automationRunId: bodyString(request.body, "automationRunId"),
        workspaceRoot: bodyString(request.body, "workspaceRoot"),
        workflowId: bodyString(request.body, "workflowId"),
        timeoutMs: bodyNumber(request.body, "timeoutMs"),
        approvalTimeoutMs: bodyNumber(request.body, "approvalTimeoutMs"),
      });
      response.status(result.claimed ? 202 : 200).json({ ...result, requestId });
    } catch (error) {
      sendError(response, requestId, error);
    }
  });

  app.post(`${ROUTE_PREFIX}/dispatch/run`, jsonBody, async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      requireOperator(request, operatorAuth);
      const agentRunId = bodyString(request.body, "agentRunId");
      if (!agentRunId) throw new NativeAgentApiError(400, "AGENT_RUN_ID_REQUIRED", "agentRunId is required.", false);
      const result = await dispatchNativeAgentRunOnce(config, {
        agentRunId,
        workspaceRoot: bodyString(request.body, "workspaceRoot"),
        timeoutMs: bodyNumber(request.body, "timeoutMs"),
        approvalTimeoutMs: bodyNumber(request.body, "approvalTimeoutMs"),
      }, store ? { store } : undefined);
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

function requireOperator(request: Request, auth: OperatorAuthConfig): OperatorAuthentication {
  return authenticateOperator(request, auth);
}

function authenticateOperator(request: Request, auth: OperatorAuthConfig): OperatorAuthentication {
  if (!auth.token) throw operatorTokenUnavailable();

  const token = bearerToken(request);
  if (token && safeEqual(token, auth.token)) return { method: "bearer" };

  const session = readOperatorSessionCookie(request, auth);
  if (session) return { method: "session", expiresAt: session.expiresAt };

  throw new NativeAgentApiError(401, "NATIVE_AGENT_OPERATOR_TOKEN_INVALID", "Missing or invalid native agent operator token.", false);
}

function operatorTokenUnavailable(): NativeAgentApiError {
  return new NativeAgentApiError(
    503,
    "NATIVE_AGENT_OPERATOR_TOKEN_UNAVAILABLE",
    "Set DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN to enable native agent operator APIs.",
    true,
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.get("authorization")?.trim();
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || undefined;
}

function setOperatorSessionCookie(response: Response, auth: OperatorAuthConfig): { expiresAt: string } {
  if (!auth.sessionSecret) throw operatorTokenUnavailable();
  const expiresAtMs = Date.now() + auth.sessionTtlSeconds * 1000;
  const nonce = randomUUID();
  const payload = `${expiresAtMs}.${nonce}`;
  const signature = signOperatorSession(payload, auth.sessionSecret);
  response.cookie(OPERATOR_SESSION_COOKIE, `${payload}.${signature}`, {
    httpOnly: true,
    maxAge: auth.sessionTtlSeconds * 1000,
    path: ROUTE_PREFIX,
    sameSite: "strict",
    secure: auth.secureCookie,
  });
  return { expiresAt: new Date(expiresAtMs).toISOString() };
}

function clearOperatorSessionCookie(response: Response, auth: OperatorAuthConfig): void {
  response.clearCookie(OPERATOR_SESSION_COOKIE, {
    path: ROUTE_PREFIX,
    sameSite: "strict",
    secure: auth.secureCookie,
  });
}

function readOperatorSessionCookie(request: Request, auth: OperatorAuthConfig): { expiresAt: string } | undefined {
  if (!auth.sessionSecret) return undefined;
  const rawCookie = cookieValue(request, OPERATOR_SESSION_COOKIE);
  if (!rawCookie) return undefined;
  const [expiresAtMsRaw, nonce, signature, ...extra] = rawCookie.split(".");
  if (!expiresAtMsRaw || !nonce || !signature || extra.length > 0) return undefined;
  const expiresAtMs = Number(expiresAtMsRaw);
  if (!Number.isInteger(expiresAtMs) || expiresAtMs <= Date.now()) return undefined;
  const payload = `${expiresAtMsRaw}.${nonce}`;
  if (!safeEqual(signature, signOperatorSession(payload, auth.sessionSecret))) return undefined;
  return { expiresAt: new Date(expiresAtMs).toISOString() };
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookieHeader = request.get("cookie");
  if (!cookieHeader) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = entry.trim().split("=");
    if (rawName !== name) continue;
    const rawValue = rawValueParts.join("=");
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return undefined;
}

function signOperatorSession(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseOperatorSessionTtl(value: string | undefined): number {
  if (!value) return DEFAULT_OPERATOR_SESSION_TTL_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60) {
    throw new Error(`Invalid DEVSPACE_NATIVE_AGENT_OPERATOR_SESSION_TTL_SECONDS: ${value}`);
  }
  return parsed;
}

function publicBaseUrlIsHttps(config: ServerConfig): boolean {
  try {
    return new URL(config.publicBaseUrl ?? "http://127.0.0.1").protocol === "https:";
  } catch {
    return false;
  }
}

function requestIdFor(request: Request, response: Response): string {
  const requestId = request.get("x-request-id")?.trim() || randomUUID();
  response.setHeader("X-Request-Id", requestId);
  return requestId;
}

function sendError(response: Response, requestId: string, error: unknown): void {
  if (error instanceof NativeAgentApiError || error instanceof NativeAgentOperatorError) {
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

function bodyJsonObject(body: unknown, key: string): JsonObject | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value) ? value as JsonObject : undefined;
}

function responseFromMessage(body: unknown): JsonObject | undefined {
  const message = bodyString(body, "message");
  return message ? { message } : undefined;
}

function bodyRisk(body: unknown): NativeAgentToolRisk | undefined {
  const value = bodyString(body, "risk");
  if (!value) return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new NativeAgentApiError(400, "INVALID_APPROVAL_RISK", "Approval risk must be low, medium, or high.", false);
}

function bodyApprovalDecision(body: unknown): NativeAgentApprovalDecision {
  const value = bodyString(body, "decision");
  if (value === "approved" || value === "denied") return value;
  throw new NativeAgentApiError(400, "INVALID_APPROVAL_DECISION", "Approval decision must be approved or denied.", false);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

function operatorConsoleHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getOperatorConsoleManifestEntry();
  const stylesheets = (entry.css ?? [])
    .map((stylesheet) => `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`)
    .join("\n");
  const runtimeConfig = JSON.stringify({ apiBasePath: ROUTE_PREFIX });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Xautojs Operator Console</title>
    <script>window.DEVSPACE_OPERATOR_CONFIG = ${runtimeConfig};</script>
    <script type="module" crossorigin src="${assetUrl(baseUrl, entry.file)}"></script>
${stylesheets}
  </head>
  <body>
    <main id="operator-app" class="operator-shell">
      <section class="operator-loading">Loading operator console...</section>
    </main>
  </body>
</html>`;
}

function readOperatorConsoleManifest(): OperatorConsoleManifest {
  return JSON.parse(readFileSync(new URL("../dist/ui/.vite/manifest.json", import.meta.url), "utf8")) as OperatorConsoleManifest;
}

function getOperatorConsoleManifestEntry(): OperatorConsoleManifestEntry {
  const manifest = readOperatorConsoleManifest();
  const entry = manifest[OPERATOR_APP_MANIFEST_ENTRY];
  if (!entry?.file) {
    throw new Error(`Missing ${OPERATOR_APP_MANIFEST_ENTRY} in UI manifest. Run npm run build.`);
  }
  return entry;
}

function assetBaseUrl(config: ServerConfig): string {
  const publicBaseUrl = config.publicBaseUrl ?? "http://127.0.0.1";
  return `${publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}
