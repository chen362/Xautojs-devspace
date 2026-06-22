import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export type AuthMode = "owner-token" | "oidc";

export interface WorkspaceIdentity {
  tenantId: string;
  userId: string;
}

export interface DevSpaceIdentity extends WorkspaceIdentity {
  authMode: AuthMode;
  issuer?: string;
  tenantExternalId?: string;
  userExternalId: string;
  clientId: string;
  scopes: string[];
}

export interface DevSpaceAuthInfo extends AuthInfo {
  devspace?: DevSpaceIdentity;
}

export interface IdentityConfig {
  deploymentMode: "local" | "production";
  oauth: {
    mode: AuthMode;
  };
}

export const LOCAL_TENANT_ID = "local";
export const LOCAL_USER_ID = "owner";

export const LOCAL_WORKSPACE_IDENTITY: WorkspaceIdentity = {
  tenantId: LOCAL_TENANT_ID,
  userId: LOCAL_USER_ID,
};

export function createLocalIdentity(scopes: string[] = [], clientId = "local-owner"): DevSpaceIdentity {
  return {
    authMode: "owner-token",
    tenantId: LOCAL_TENANT_ID,
    tenantExternalId: LOCAL_TENANT_ID,
    userId: LOCAL_USER_ID,
    userExternalId: LOCAL_USER_ID,
    clientId,
    scopes,
  };
}

export function createOidcIdentity(input: {
  issuer: string;
  subject: string;
  tenantExternalId?: string;
  clientId?: string;
  scopes: string[];
}): DevSpaceIdentity {
  const issuer = normalizeRequiredIdentityValue(input.issuer, "issuer");
  const subject = normalizeRequiredIdentityValue(input.subject, "subject");
  const tenantExternalId = normalizeIdentityValue(input.tenantExternalId) ?? issuer;
  const tenantId = `${issuer}#${tenantExternalId}`;
  const userId = `${tenantId}#${subject}`;

  return {
    authMode: "oidc",
    issuer,
    tenantId,
    tenantExternalId,
    userId,
    userExternalId: subject,
    clientId: normalizeIdentityValue(input.clientId) ?? subject,
    scopes: input.scopes,
  };
}

export function identityFromAuthInfo(config: IdentityConfig, auth: AuthInfo | undefined): DevSpaceIdentity {
  const identity = (auth as DevSpaceAuthInfo | undefined)?.devspace;
  if (identity) return identity;

  if (config.deploymentMode === "production") {
    throw new Error("Authenticated request is missing DevSpace identity context.");
  }

  return createLocalIdentity(auth?.scopes ?? [], auth?.clientId ?? "local-owner");
}

export function identityMatches(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

export function identityLogFields(identity: WorkspaceIdentity): {
  tenantId: string;
  userId: string;
} {
  return {
    tenantId: identity.tenantId,
    userId: identity.userId,
  };
}

function normalizeRequiredIdentityValue(value: string | undefined, name: string): string {
  const normalized = normalizeIdentityValue(value);
  if (!normalized) throw new Error(`OIDC ${name} is required for DevSpace identity.`);
  return normalized;
}

function normalizeIdentityValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
