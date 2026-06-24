import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { CloudDeviceWebSocketAuthenticator } from "./cloud-device-websocket-route.js";
import type { WorkspaceIdentity } from "./identity.js";

const TOKEN_VERSION = 1;

export interface CloudGatewayDeviceTokenPayload {
  version: typeof TOKEN_VERSION;
  tenantId: string;
  userId: string;
  deviceId?: string;
  desktopInstanceId?: string;
  issuedAt?: string;
  expiresAt?: string;
}

export interface CloudGatewayDeviceAuthContext {
  owner: WorkspaceIdentity;
  deviceId?: string;
  desktopInstanceId?: string;
  expiresAt?: string;
}

export interface SignedCloudGatewayDeviceAuthOptions {
  secret: string;
  now?: () => string;
  allowQueryToken?: boolean;
}

export class CloudGatewayAuthError extends Error {
  constructor(readonly code: "AUTH_MISSING" | "AUTH_INVALID" | "AUTH_EXPIRED", message: string) {
    super(message);
    this.name = "CloudGatewayAuthError";
  }
}

export function issueCloudGatewayDeviceToken(
  payload: Omit<CloudGatewayDeviceTokenPayload, "version">,
  secret: string,
): string {
  const normalized: CloudGatewayDeviceTokenPayload = {
    version: TOKEN_VERSION,
    tenantId: requiredTokenField(payload.tenantId, "tenantId"),
    userId: requiredTokenField(payload.userId, "userId"),
    deviceId: optionalTokenField(payload.deviceId),
    desktopInstanceId: optionalTokenField(payload.desktopInstanceId),
    issuedAt: optionalTokenField(payload.issuedAt),
    expiresAt: optionalTokenField(payload.expiresAt),
  };
  const body = base64UrlEncode(JSON.stringify(normalized));
  const signature = signTokenBody(body, secret);
  return `v1.${body}.${signature}`;
}

export function verifyCloudGatewayDeviceToken(
  token: string,
  secret: string,
  now = new Date().toISOString(),
): CloudGatewayDeviceAuthContext {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new CloudGatewayAuthError("AUTH_INVALID", "Device auth token has an invalid format.");
  }

  const [, body, signature] = parts;
  if (!body || !signature || !safeEqual(signature, signTokenBody(body, secret))) {
    throw new CloudGatewayAuthError("AUTH_INVALID", "Device auth token signature is invalid.");
  }

  const payload = parsePayload(body);
  if (payload.version !== TOKEN_VERSION) {
    throw new CloudGatewayAuthError("AUTH_INVALID", "Device auth token version is unsupported.");
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.parse(now)) {
    throw new CloudGatewayAuthError("AUTH_EXPIRED", "Device auth token is expired.");
  }

  return {
    owner: {
      tenantId: requiredTokenField(payload.tenantId, "tenantId"),
      userId: requiredTokenField(payload.userId, "userId"),
    },
    deviceId: optionalTokenField(payload.deviceId),
    desktopInstanceId: optionalTokenField(payload.desktopInstanceId),
    expiresAt: optionalTokenField(payload.expiresAt),
  };
}

export function createSignedCloudDeviceWebSocketAuthenticator(
  options: SignedCloudGatewayDeviceAuthOptions,
): CloudDeviceWebSocketAuthenticator {
  const secret = requiredTokenField(options.secret, "secret");
  return (request: IncomingMessage) => {
    const token = extractBearerToken(request, options.allowQueryToken ?? false);
    if (!token) return undefined;
    return verifyCloudGatewayDeviceToken(token, secret, options.now?.());
  };
}

function extractBearerToken(request: IncomingMessage, allowQueryToken: boolean): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }

  if (allowQueryToken) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const token = url.searchParams.get("access_token")?.trim();
    if (token) return token;
  }

  return undefined;
}

function parsePayload(body: string): CloudGatewayDeviceTokenPayload {
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("payload is not an object");
    return {
      version: parsed.version === TOKEN_VERSION ? TOKEN_VERSION : 0 as typeof TOKEN_VERSION,
      tenantId: typeof parsed.tenantId === "string" ? parsed.tenantId : "",
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : undefined,
      desktopInstanceId: typeof parsed.desktopInstanceId === "string" ? parsed.desktopInstanceId : undefined,
      issuedAt: typeof parsed.issuedAt === "string" ? parsed.issuedAt : undefined,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : undefined,
    };
  } catch {
    throw new CloudGatewayAuthError("AUTH_INVALID", "Device auth token payload is invalid.");
  }
}

function signTokenBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function requiredTokenField(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new CloudGatewayAuthError("AUTH_INVALID", `${field} is required in device auth token.`);
  return trimmed;
}

function optionalTokenField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
