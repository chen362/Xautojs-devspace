import { randomBytes, randomUUID } from "node:crypto";
import { CloudRoutingError, cloudRouteNow, isCloudRouteExpired, normalizeCloudRouteOwner, normalizeOptionalCloudRoutingId, normalizeRequiredCloudRoutingId } from "./cloud-routing-contract.js";
import { issueCloudGatewayDeviceToken } from "./cloud-gateway-auth.js";
import type { CloudControlPlaneAuditStore } from "./cloud-control-plane-audit.js";
import type { WorkspaceIdentity } from "./identity.js";

export type CloudDeviceAuthorizationStatus = "pending" | "approved" | "denied";

export interface CloudDeviceAuthorizationRecord {
  deviceCode: string;
  userCode: string;
  status: CloudDeviceAuthorizationStatus;
  clientName?: string;
  deviceId?: string;
  desktopInstanceId?: string;
  owner?: WorkspaceIdentity;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
  approvedAt?: string;
  deniedAt?: string;
  lastPolledAt?: string;
}

export interface CreateCloudDeviceAuthorizationInput {
  clientName?: string;
  deviceId?: string;
  desktopInstanceId?: string;
  now?: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
}

export interface CreateCloudDeviceAuthorizationResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface ApproveCloudDeviceAuthorizationInput {
  userCode: string;
  owner: WorkspaceIdentity;
  deviceId?: string;
  desktopInstanceId?: string;
  now?: string;
}

export interface PollCloudDeviceTokenInput {
  deviceCode: string;
  now?: string;
}

export interface PollCloudDeviceTokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  owner: WorkspaceIdentity;
  deviceId?: string;
  desktopInstanceId?: string;
}

export interface CloudDeviceAuthorizationStore {
  create(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord>;
  getByDeviceCode(deviceCode: string): Promise<CloudDeviceAuthorizationRecord | undefined>;
  getByUserCode(userCode: string): Promise<CloudDeviceAuthorizationRecord | undefined>;
  update(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord>;
  close?(): Promise<void>;
}

export class CloudDeviceAuthorizationError extends Error {
  constructor(
    readonly code:
      | "AUTHORIZATION_PENDING"
      | "SLOW_DOWN"
      | "EXPIRED_TOKEN"
      | "ACCESS_DENIED"
      | "INVALID_DEVICE_CODE"
      | "INVALID_USER_CODE",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CloudDeviceAuthorizationError";
  }
}

export class InMemoryCloudDeviceAuthorizationStore implements CloudDeviceAuthorizationStore {
  private readonly byDeviceCode = new Map<string, CloudDeviceAuthorizationRecord>();
  private readonly byUserCode = new Map<string, string>();

  async create(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord> {
    const record = cloneRecord(input);
    this.byDeviceCode.set(record.deviceCode, record);
    this.byUserCode.set(record.userCode, record.deviceCode);
    return cloneRecord(record);
  }

  async getByDeviceCode(deviceCode: string): Promise<CloudDeviceAuthorizationRecord | undefined> {
    const record = this.byDeviceCode.get(deviceCode);
    return record ? cloneRecord(record) : undefined;
  }

  async getByUserCode(userCode: string): Promise<CloudDeviceAuthorizationRecord | undefined> {
    const deviceCode = this.byUserCode.get(userCode.toUpperCase());
    if (!deviceCode) return undefined;
    return this.getByDeviceCode(deviceCode);
  }

  async update(input: CloudDeviceAuthorizationRecord): Promise<CloudDeviceAuthorizationRecord> {
    const record = cloneRecord(input);
    this.byDeviceCode.set(record.deviceCode, record);
    this.byUserCode.set(record.userCode, record.deviceCode);
    return cloneRecord(record);
  }
}

export interface CloudDeviceAuthorizationServiceOptions {
  store?: CloudDeviceAuthorizationStore;
  auditStore?: CloudControlPlaneAuditStore;
  tokenSecret: string;
  verificationUri: string;
  authorizationTtlSeconds?: number;
  tokenTtlSeconds?: number;
  pollIntervalSeconds?: number;
  now?: () => string;
}

export class CloudDeviceAuthorizationService {
  private readonly store: CloudDeviceAuthorizationStore;
  private readonly authorizationTtlSeconds: number;
  private readonly tokenTtlSeconds: number;
  private readonly pollIntervalSeconds: number;
  private readonly now: () => string;

  constructor(private readonly options: CloudDeviceAuthorizationServiceOptions) {
    this.store = options.store ?? new InMemoryCloudDeviceAuthorizationStore();
    this.authorizationTtlSeconds = options.authorizationTtlSeconds ?? 600;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 86_400;
    this.pollIntervalSeconds = options.pollIntervalSeconds ?? 5;
    this.now = options.now ?? (() => new Date().toISOString());
    normalizeRequiredCloudRoutingId(options.tokenSecret, "tokenSecret");
    normalizeRequiredCloudRoutingId(options.verificationUri, "verificationUri");
  }

  async create(input: CreateCloudDeviceAuthorizationInput = {}): Promise<CreateCloudDeviceAuthorizationResult> {
    const now = cloudRouteNow(input.now ?? this.now());
    const expiresInSeconds = input.expiresInSeconds ?? this.authorizationTtlSeconds;
    const intervalSeconds = input.intervalSeconds ?? this.pollIntervalSeconds;
    const expiresAt = addSeconds(now, expiresInSeconds);
    const record = await this.store.create({
      deviceCode: `dc_${randomUUID()}`,
      userCode: await this.uniqueUserCode(),
      status: "pending",
      clientName: normalizeOptionalCloudRoutingId(input.clientName, "clientName"),
      deviceId: normalizeOptionalCloudRoutingId(input.deviceId, "deviceId"),
      desktopInstanceId: normalizeOptionalCloudRoutingId(input.desktopInstanceId, "desktopInstanceId"),
      createdAt: now,
      expiresAt,
      intervalSeconds,
    });

    await this.options.auditStore?.recordEvent({ action: "device_code.create", status: "completed", now });
    return {
      deviceCode: record.deviceCode,
      userCode: record.userCode,
      verificationUri: this.options.verificationUri,
      expiresAt: record.expiresAt,
      expiresInSeconds,
      intervalSeconds,
    };
  }

  async approve(input: ApproveCloudDeviceAuthorizationInput): Promise<CloudDeviceAuthorizationRecord> {
    const now = cloudRouteNow(input.now ?? this.now());
    const userCode = normalizeUserCode(input.userCode);
    const existing = await this.store.getByUserCode(userCode);
    if (!existing) throw new CloudDeviceAuthorizationError("INVALID_USER_CODE", "User code was not found.");
    if (isCloudRouteExpired(existing.expiresAt, now)) throw new CloudDeviceAuthorizationError("EXPIRED_TOKEN", "Device code is expired.");
    if (existing.status === "denied") throw new CloudDeviceAuthorizationError("ACCESS_DENIED", "Device authorization was denied.");

    const owner = normalizeCloudRouteOwner(input.owner);
    const deviceId = normalizeOptionalCloudRoutingId(input.deviceId, "deviceId") ?? existing.deviceId;
    const desktopInstanceId = normalizeOptionalCloudRoutingId(input.desktopInstanceId, "desktopInstanceId") ?? existing.desktopInstanceId;

    if (existing.status === "approved" && existing.owner) {
      if (!sameApprovedTarget(existing, { owner, deviceId, desktopInstanceId })) {
        throw new CloudDeviceAuthorizationError(
          "ACCESS_DENIED",
          "Device authorization is already approved for another owner or device.",
        );
      }
      return existing;
    }

    const record = await this.store.update({
      ...existing,
      status: "approved",
      owner,
      deviceId,
      desktopInstanceId,
      approvedAt: now,
    });
    await this.options.auditStore?.recordEvent({ owner, action: "device_code.approve", status: "completed", now });
    return record;
  }

  async deny(userCodeInput: string, nowInput?: string): Promise<CloudDeviceAuthorizationRecord> {
    const now = cloudRouteNow(nowInput ?? this.now());
    const userCode = normalizeUserCode(userCodeInput);
    const existing = await this.store.getByUserCode(userCode);
    if (!existing) throw new CloudDeviceAuthorizationError("INVALID_USER_CODE", "User code was not found.");
    const record = await this.store.update({ ...existing, status: "denied", deniedAt: now });
    await this.options.auditStore?.recordEvent({ owner: record.owner, action: "device_code.approve", status: "failed", errorCode: "ACCESS_DENIED", now });
    return record;
  }

  async poll(input: PollCloudDeviceTokenInput): Promise<PollCloudDeviceTokenResult> {
    const now = cloudRouteNow(input.now ?? this.now());
    const deviceCode = normalizeRequiredCloudRoutingId(input.deviceCode, "deviceCode");
    const existing = await this.store.getByDeviceCode(deviceCode);
    if (!existing) throw new CloudDeviceAuthorizationError("INVALID_DEVICE_CODE", "Device code was not found.");
    if (isCloudRouteExpired(existing.expiresAt, now)) throw new CloudDeviceAuthorizationError("EXPIRED_TOKEN", "Device code is expired.");
    if (existing.status === "denied") throw new CloudDeviceAuthorizationError("ACCESS_DENIED", "Device authorization was denied.");
    if (existing.lastPolledAt && Date.parse(now) - Date.parse(existing.lastPolledAt) < existing.intervalSeconds * 1_000) {
      await this.store.update({ ...existing, lastPolledAt: now });
      throw new CloudDeviceAuthorizationError("SLOW_DOWN", "Polling interval has not elapsed yet.", true);
    }
    if (existing.status !== "approved" || !existing.owner) {
      await this.store.update({ ...existing, lastPolledAt: now });
      throw new CloudDeviceAuthorizationError("AUTHORIZATION_PENDING", "Device authorization is still pending.", true);
    }

    const tokenExpiresAt = addSeconds(now, this.tokenTtlSeconds);
    const accessToken = issueCloudGatewayDeviceToken({
      tenantId: existing.owner.tenantId,
      userId: existing.owner.userId,
      deviceId: existing.deviceId,
      desktopInstanceId: existing.desktopInstanceId,
      issuedAt: now,
      expiresAt: tokenExpiresAt,
    }, this.options.tokenSecret);
    await this.store.update({ ...existing, lastPolledAt: now });
    await this.options.auditStore?.recordEvent({ owner: existing.owner, action: "device_code.poll", status: "completed", now });

    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt: tokenExpiresAt,
      owner: existing.owner,
      deviceId: existing.deviceId,
      desktopInstanceId: existing.desktopInstanceId,
    };
  }

  close(): Promise<void> {
    return this.store.close?.() ?? Promise.resolve();
  }

  private async uniqueUserCode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = formatUserCode(randomBytes(5).toString("hex"));
      if (!(await this.store.getByUserCode(code))) return code;
    }
    throw new CloudRoutingError("TOOL_CALL_CONFLICT", "Unable to allocate a unique device user code.");
  }
}

function sameApprovedTarget(
  existing: CloudDeviceAuthorizationRecord,
  next: { owner: WorkspaceIdentity; deviceId?: string; desktopInstanceId?: string },
): boolean {
  if (!existing.owner) return false;
  return existing.owner.tenantId === next.owner.tenantId
    && existing.owner.userId === next.owner.userId
    && existing.deviceId === next.deviceId
    && existing.desktopInstanceId === next.desktopInstanceId;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1_000).toISOString();
}

function formatUserCode(seed: string): string {
  const raw = seed.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 8).padEnd(8, "0");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizeUserCode(value: string): string {
  return normalizeRequiredCloudRoutingId(value, "userCode").toUpperCase();
}

function cloneRecord(record: CloudDeviceAuthorizationRecord): CloudDeviceAuthorizationRecord {
  return {
    ...record,
    owner: record.owner ? { tenantId: record.owner.tenantId, userId: record.owner.userId } : undefined,
  };
}
