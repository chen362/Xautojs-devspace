import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { isPostgresDatabaseConfig } from "./db/types.js";
import type { CloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import {
  CloudDeviceAuthorizationError,
  CloudDeviceAuthorizationService,
  InMemoryCloudDeviceAuthorizationStore,
  type CloudDeviceAuthorizationStore,
} from "./cloud-device-code-auth.js";
import { PostgresCloudDeviceAuthorizationStore } from "./postgres-cloud-device-authorization-store.js";
import type { WorkspaceIdentity } from "./identity.js";

export interface CloudDeviceCodeApiOptions {
  service?: CloudDeviceAuthorizationService;
  store?: CloudDeviceAuthorizationStore;
  auditStore?: CloudControlPlaneAuditStore;
  tokenSecret?: string;
  verificationUri?: string;
  authorizationTtlSeconds?: number;
  tokenTtlSeconds?: number;
  pollIntervalSeconds?: number;
  resolveOwner?: (request: Request) => Promise<WorkspaceIdentity | undefined> | WorkspaceIdentity | undefined;
}

export interface RegisteredCloudDeviceCodeApiRoutes {
  service: CloudDeviceAuthorizationService;
  close(): Promise<void>;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: unknown;
  };
}

export function registerCloudDeviceCodeApiRoutes(
  app: Express,
  config: ServerConfig = loadConfig(),
  options: CloudDeviceCodeApiOptions = {},
): RegisteredCloudDeviceCodeApiRoutes {
  const service = options.service ?? createCloudDeviceAuthorizationService(config, options);
  const jsonParser = express.json({ limit: "16kb" });

  app.post("/api/cloud/device-code", jsonParser, async (req, res) => {
    try {
      const body = requestBody(req);
      const result = await service.create({
        clientName: optionalString(body.clientName),
        deviceId: optionalString(body.deviceId),
        desktopInstanceId: optionalString(body.desktopInstanceId),
      });
      res.status(201).json({
        ...result,
        verificationUriComplete: verificationUriComplete(result.verificationUri, result.userCode),
        requestId: requestId(res),
      });
    } catch (error) {
      sendApiError(res, 400, "INVALID_REQUEST", errorMessage(error), false);
    }
  });

  app.post("/api/cloud/device-code/token", jsonParser, async (req, res) => {
    try {
      const body = requestBody(req);
      const deviceCode = requiredString(body.deviceCode, "deviceCode");
      const result = await service.poll({ deviceCode });
      res.json({
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresAt: result.expiresAt,
        owner: result.owner,
        deviceId: result.deviceId,
        desktopInstanceId: result.desktopInstanceId,
        requestId: requestId(res),
      });
    } catch (error) {
      sendDeviceAuthorizationError(res, error);
    }
  });

  app.post("/api/cloud/device-code/:userCode/approve", jsonParser, async (req, res) => {
    try {
      const owner = await resolveOwner(req, options);
      const body = requestBody(req);
      const record = await service.approve({
        userCode: req.params.userCode ?? "",
        owner,
        deviceId: optionalString(body.deviceId),
        desktopInstanceId: optionalString(body.desktopInstanceId),
      });
      res.json({
        status: record.status,
        userCode: record.userCode,
        deviceId: record.deviceId,
        desktopInstanceId: record.desktopInstanceId,
        expiresAt: record.expiresAt,
        approvedAt: record.approvedAt,
        requestId: requestId(res),
      });
    } catch (error) {
      sendDeviceAuthorizationError(res, error);
    }
  });

  app.post("/api/cloud/device-code/:userCode/deny", jsonParser, async (req, res) => {
    try {
      await resolveOwner(req, options);
      const record = await service.deny(req.params.userCode ?? "");
      res.json({
        status: record.status,
        userCode: record.userCode,
        deniedAt: record.deniedAt,
        requestId: requestId(res),
      });
    } catch (error) {
      sendDeviceAuthorizationError(res, error);
    }
  });

  return {
    service,
    close: () => service.close(),
  };
}

export function createCloudDeviceAuthorizationService(
  config: ServerConfig = loadConfig(),
  options: CloudDeviceCodeApiOptions = {},
): CloudDeviceAuthorizationService {
  const tokenSecret = options.tokenSecret
    ?? process.env.DEVSPACE_CLOUD_DEVICE_TOKEN_SECRET
    ?? config.oauth.ownerToken;
  if (!tokenSecret?.trim()) {
    throw new Error("DEVSPACE_CLOUD_DEVICE_TOKEN_SECRET is required for cloud device-code token issuance.");
  }

  return new CloudDeviceAuthorizationService({
    store: options.store ?? createDefaultDeviceAuthorizationStore(config),
    auditStore: options.auditStore,
    tokenSecret,
    verificationUri: options.verificationUri ?? `${config.publicBaseUrl.replace(/\/+$/, "")}/cloud/device`,
    authorizationTtlSeconds: options.authorizationTtlSeconds,
    tokenTtlSeconds: options.tokenTtlSeconds,
    pollIntervalSeconds: options.pollIntervalSeconds,
  });
}

function createDefaultDeviceAuthorizationStore(config: ServerConfig): CloudDeviceAuthorizationStore {
  if (isPostgresDatabaseConfig(config.database)) return new PostgresCloudDeviceAuthorizationStore(config.database);
  return new InMemoryCloudDeviceAuthorizationStore();
}

async function resolveOwner(request: Request, options: CloudDeviceCodeApiOptions): Promise<WorkspaceIdentity> {
  const owner = await options.resolveOwner?.(request);
  if (!owner) throw new CloudDeviceAuthorizationError("ACCESS_DENIED", "Authenticated owner context is required.");
  return owner;
}

function requestBody(request: Request): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return {};
  return request.body as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(value: unknown, field: string): string {
  const trimmed = optionalString(value);
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function verificationUriComplete(verificationUri: string, userCode: string): string {
  try {
    const url = new URL(verificationUri);
    url.searchParams.set("user_code", userCode);
    return url.toString();
  } catch {
    const separator = verificationUri.includes("?") ? "&" : "?";
    return `${verificationUri}${separator}user_code=${encodeURIComponent(userCode)}`;
  }
}

function requestId(res: Response): string {
  const existing = res.locals.requestId;
  return typeof existing === "string" && existing.trim() ? existing : randomUUID();
}

function sendDeviceAuthorizationError(res: Response, error: unknown): void {
  if (error instanceof CloudDeviceAuthorizationError) {
    const status = statusForDeviceAuthorizationError(error);
    if (error.code === "AUTHORIZATION_PENDING") {
      res.status(status).json({
        status: "authorization_pending",
        error: errorBody(res, error.code, error.message, error.retryable),
      });
      return;
    }
    sendApiError(res, status, error.code, error.message, error.retryable);
    return;
  }
  sendApiError(res, 400, "INVALID_REQUEST", errorMessage(error), false);
}

function statusForDeviceAuthorizationError(error: CloudDeviceAuthorizationError): number {
  switch (error.code) {
    case "AUTHORIZATION_PENDING":
      return 202;
    case "SLOW_DOWN":
      return 429;
    case "ACCESS_DENIED":
      return 403;
    case "INVALID_DEVICE_CODE":
    case "INVALID_USER_CODE":
      return 404;
    case "EXPIRED_TOKEN":
      return 400;
  }
}

function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): void {
  res.status(status).json({ error: errorBody(res, code, message, retryable, details) } satisfies ApiErrorBody);
}

function errorBody(
  res: Response,
  code: string,
  message: string,
  retryable: boolean,
  details?: unknown,
): ApiErrorBody["error"] {
  return {
    code,
    message,
    retryable,
    requestId: requestId(res),
    details,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
