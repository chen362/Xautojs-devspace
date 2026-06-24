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
  const formParser = express.urlencoded({ extended: false, limit: "16kb" });

  app.get("/cloud/device", (req, res) => {
    const userCode = optionalString(req.query.user_code) ?? optionalString(req.query.userCode) ?? "";
    res.type("html").send(renderDeviceApprovalPage(userCode));
  });

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

  app.post("/api/cloud/device-code/:userCode/approve", formParser, jsonParser, async (req, res) => {
    try {
      const owner = await resolveOwner(req, options);
      const body = requestBody(req);
      const record = await service.approve({
        userCode: req.params.userCode ?? "",
        owner,
        deviceId: optionalString(body.deviceId),
        desktopInstanceId: optionalString(body.desktopInstanceId),
      });
      if (isFormPost(req)) {
        res.type("html").send(renderDeviceApprovalResult("approved", record.userCode));
        return;
      }
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

  app.post("/api/cloud/device-code/:userCode/deny", formParser, jsonParser, async (req, res) => {
    try {
      await resolveOwner(req, options);
      const record = await service.deny(req.params.userCode ?? "");
      if (isFormPost(req)) {
        res.type("html").send(renderDeviceApprovalResult("denied", record.userCode));
        return;
      }
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

function isFormPost(request: Request): boolean {
  return Boolean(request.is("application/x-www-form-urlencoded"));
}

function renderDeviceApprovalPage(userCode: string): string {
  const code = userCode.toUpperCase();
  const hasCode = Boolean(code);
  const approveAction = hasCode ? `/api/cloud/device-code/${encodeURIComponent(code)}/approve` : "#";
  const denyAction = hasCode ? `/api/cloud/device-code/${encodeURIComponent(code)}/deny` : "#";
  return renderHtmlPage("Connect Xautojs Desktop", `
    <main>
      <section class="panel">
        <p class="eyebrow">Xautojs Devspace</p>
        <h1>Connect Desktop</h1>
        <p class="lede">Review the user code shown by your Desktop app, then approve or deny this device for the authenticated account.</p>
        ${hasCode ? `<div class="code">${escapeHtml(code)}</div>` : `<p class="error">Enter a user code from the Desktop app in the URL as <code>?user_code=XXXX-XXXX</code>.</p>`}
        <form method="post" action="${escapeHtml(approveAction)}">
          <label>Device id override <input name="deviceId" autocomplete="off" placeholder="optional" /></label>
          <label>Desktop instance override <input name="desktopInstanceId" autocomplete="off" placeholder="optional" /></label>
          <button ${hasCode ? "" : "disabled"} type="submit">Approve device</button>
        </form>
        <form method="post" action="${escapeHtml(denyAction)}">
          <button ${hasCode ? "" : "disabled"} class="secondary" type="submit">Deny device</button>
        </form>
      </section>
    </main>
  `);
}

function renderDeviceApprovalResult(status: "approved" | "denied", userCode: string): string {
  const title = status === "approved" ? "Desktop Approved" : "Desktop Denied";
  const message = status === "approved"
    ? "You can return to Xautojs Desktop; it will receive a device token on the next poll."
    : "The Desktop login request was denied.";
  return renderHtmlPage(title, `
    <main>
      <section class="panel">
        <p class="eyebrow">Xautojs Devspace</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="code">${escapeHtml(userCode)}</div>
        <p class="lede">${escapeHtml(message)}</p>
      </section>
    </main>
  `);
}

function renderHtmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f8; color: #111827; }
    main { width: min(92vw, 520px); }
    .panel { background: #ffffff; border: 1px solid #d9dee5; border-radius: 8px; padding: 28px; box-shadow: 0 18px 42px rgba(15, 23, 42, 0.10); }
    .eyebrow { margin: 0 0 8px; color: #526071; font-size: 13px; font-weight: 700; text-transform: uppercase; }
    h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: 0; }
    .lede { color: #526071; line-height: 1.55; }
    .code { margin: 20px 0; padding: 14px 16px; border: 1px solid #c9d1dc; border-radius: 8px; font: 700 28px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; letter-spacing: 0.08em; background: #f3f5f7; }
    .error { color: #b42318; }
    form { display: grid; gap: 12px; margin-top: 16px; }
    label { display: grid; gap: 6px; color: #526071; font-size: 13px; }
    input { border: 1px solid #c9d1dc; border-radius: 6px; padding: 10px 12px; font: inherit; }
    button { border: 0; border-radius: 6px; padding: 11px 14px; background: #14532d; color: #ffffff; font-weight: 700; cursor: pointer; }
    button.secondary { background: #7f1d1d; }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #f8fafc; }
      .panel { background: #111827; border-color: #334155; box-shadow: none; }
      .lede, .eyebrow, label { color: #cbd5e1; }
      .code { background: #172033; border-color: #475569; }
      input { background: #0f172a; border-color: #475569; color: #f8fafc; }
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
