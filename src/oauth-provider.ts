import { timingSafeEqual, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createLocalIdentity, createOidcIdentity, type DevSpaceAuthInfo } from "./identity.js";
import {
  SqliteOAuthClientsStore,
  SqliteOAuthStore,
  type PersistedAccessTokenRecord,
  type PersistedRefreshTokenRecord,
} from "./oauth-store.js";

export interface OidcOAuthConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  userClaim: string;
  tenantClaim?: string;
  clockToleranceSeconds: number;
}

export interface OAuthConfig {
  mode: "owner-token" | "oidc";
  ownerToken?: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
  oidc?: OidcOAuthConfig;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "devspace";
  const resourceText = params.resource?.href ?? "DevSpace MCP endpoint";
  const error = params.error
    ? `<p class="error">${htmlEscape(params.error)}</p>`
    : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect DevSpace</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 440px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { line-height: 1.5; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect DevSpace</h1>
      <p class="warning">Only approve this if you are intentionally connecting your own ChatGPT or MCP client to this local machine.</p>
      ${error}
      <dl>
        <dt>Client</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>Scope</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>Resource</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize DevSpace</button>
      </form>
    </main>
  </body>
</html>`;
}

function requestedScopesAllowed(requested: string[], supported: string[]): boolean {
  return requested.every((scope) => supported.includes(scope));
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class InMemoryOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly allowedRedirectHosts: string[]) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(uri, this.allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };
    this.clients.set(registered.client_id, registered);
    return registered;
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly resourceServerUrl: URL;
  private readonly oidcJwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly oauthStore?: SqliteOAuthStore;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateDir?: string,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    if (config.mode === "owner-token" && stateDir) {
      this.oauthStore = new SqliteOAuthStore(stateDir);
      this.clientsStore = new SqliteOAuthClientsStore(this.oauthStore, config.allowedRedirectHosts);
    } else {
      this.clientsStore = new InMemoryOAuthClientsStore(config.allowedRedirectHosts);
    }
    this.oidcJwks = config.mode === "oidc" && config.oidc
      ? createRemoteJWKSet(new URL(config.oidc.jwksUri))
      : undefined;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.assertOwnerTokenMode();
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!requestedScopesAllowed(params.scopes ?? [], this.config.scopes)) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const providedToken = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(providedToken, this.requiredOwnerToken())) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "The Owner password was not accepted.",
          clientName: client.client_name ?? client.client_id,
          scopes: params.scopes ?? this.config.scopes,
          resource: params.resource,
          fields: authorizationFormFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      clientId: client.client_id,
      params,
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.assertOwnerTokenMode();
    const record = this.validCodeRecord(client, authorizationCode);
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertOwnerTokenMode();
    const record = this.validCodeRecord(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.assertOwnerTokenMode();
    const refreshTokenHash = hashToken(refreshToken);
    const record = this.refreshTokenRecord(refreshTokenHash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }

    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }

    return this.issueTokens(client.client_id, requestedScopes, resource ?? record.resource, refreshTokenHash);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.config.mode === "oidc") {
      return this.verifyOidcAccessToken(token);
    }

    const record = this.accessTokenRecord(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    const authInfo: DevSpaceAuthInfo = {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource,
      devspace: createLocalIdentity(record.scopes, record.clientId),
    };
    return authInfo;
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.assertOwnerTokenMode();
    const hashed = hashToken(request.token);
    if (this.oauthStore) {
      this.oauthStore.deleteAccessToken(hashed);
      this.oauthStore.deleteRefreshToken(hashed);
      return;
    }

    this.accessTokens.delete(hashed);
    this.refreshTokens.delete(hashed);
  }

  close(): void {
    this.oauthStore?.close();
  }

  private accessTokenRecord(tokenHash: string): AccessTokenRecord | undefined {
    if (!this.oauthStore) return this.accessTokens.get(tokenHash);

    const record = this.oauthStore.getAccessToken(tokenHash);
    return record ? persistedAccessTokenRecord(record) : undefined;
  }

  private refreshTokenRecord(tokenHash: string): RefreshTokenRecord | undefined {
    if (!this.oauthStore) return this.refreshTokens.get(tokenHash);

    const record = this.oauthStore.getRefreshToken(tokenHash);
    return record ? persistedRefreshTokenRecord(record) : undefined;
  }

  private async verifyOidcAccessToken(token: string): Promise<AuthInfo> {
    const oidc = this.requiredOidcConfig();
    const jwks = this.requiredOidcJwks();

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: oidc.issuer,
        audience: oidc.audience,
        clockTolerance: oidc.clockToleranceSeconds,
      });
      const scopes = scopesFromPayload(payload);
      const missingScopes = this.config.scopes.filter((scope) => !scopes.includes(scope));
      if (missingScopes.length > 0) {
        throw new InvalidTokenError(`Token is missing required scope: ${missingScopes.join(", ")}`);
      }
      if (!payload.exp) {
        throw new InvalidTokenError("Token is missing exp claim");
      }

      const subject = claimAsString(payload, oidc.userClaim) ?? payload.sub;
      if (!subject) {
        throw new InvalidTokenError(`Token is missing user claim: ${oidc.userClaim}`);
      }
      const tenantExternalId = oidc.tenantClaim ? claimAsString(payload, oidc.tenantClaim) : undefined;
      if (oidc.tenantClaim && !tenantExternalId) {
        throw new InvalidTokenError(`Token is missing tenant claim: ${oidc.tenantClaim}`);
      }
      const clientId = claimAsString(payload, "client_id") ?? claimAsString(payload, "azp") ?? subject;
      const authInfo: DevSpaceAuthInfo = {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: this.resourceServerUrl,
        devspace: createOidcIdentity({
          issuer: oidc.issuer,
          subject,
          tenantExternalId,
          clientId,
          scopes,
        }),
      };
      return authInfo;
    } catch (error) {
      if (error instanceof InvalidTokenError) throw error;
      throw new InvalidTokenError(error instanceof Error ? error.message : "Invalid OIDC access token");
    }
  }

  private validCodeRecord(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): AuthorizationCodeRecord {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: URL,
    consumedRefreshTokenHash?: string,
  ): OAuthTokens {
    this.assertOwnerTokenMode();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;
    const accessTokenHash = hashToken(accessToken);
    const refreshTokenHash = hashToken(refreshToken);

    if (this.oauthStore) {
      const saved = this.oauthStore.saveTokenPair(
        {
          accessTokenHash,
          accessToken: {
            clientId,
            scopes,
            expiresAt: accessExpiresAt,
            resource: resource?.href,
          },
          refreshTokenHash,
          refreshToken: {
            clientId,
            scopes,
            expiresAt: refreshExpiresAt,
            resource: resource?.href,
          },
        },
        consumedRefreshTokenHash,
      );
      if (!saved) throw new InvalidGrantError("Invalid refresh token");
    } else {
      if (consumedRefreshTokenHash && !this.refreshTokens.delete(consumedRefreshTokenHash)) {
        throw new InvalidGrantError("Invalid refresh token");
      }

      this.accessTokens.set(accessTokenHash, {
        clientId,
        scopes,
        expiresAt: accessExpiresAt,
        resource,
      });
      this.refreshTokens.set(refreshTokenHash, {
        clientId,
        scopes,
        expiresAt: refreshExpiresAt,
        resource,
      });
    }

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private assertOwnerTokenMode(): void {
    if (this.config.mode !== "owner-token") {
      throw new InvalidRequestError("Local owner-token OAuth flow is disabled in OIDC auth mode");
    }
  }

  private requiredOwnerToken(): string {
    if (!this.config.ownerToken) {
      throw new InvalidRequestError("Owner token is not configured");
    }
    return this.config.ownerToken;
  }

  private requiredOidcConfig(): OidcOAuthConfig {
    if (this.config.mode !== "oidc" || !this.config.oidc) {
      throw new InvalidTokenError("OIDC auth is not configured");
    }
    return this.config.oidc;
  }

  private requiredOidcJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!this.oidcJwks) {
      throw new InvalidTokenError("OIDC JWKS is not configured");
    }
    return this.oidcJwks;
  }
}

function authorizationFormFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function scopesFromPayload(payload: JWTPayload): string[] {
  const scopeClaim = payload.scope;
  if (typeof scopeClaim === "string") {
    return scopeClaim.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }

  const scpClaim = payload.scp;
  if (Array.isArray(scpClaim)) {
    return scpClaim.filter((scope): scope is string => typeof scope === "string");
  }
  if (typeof scpClaim === "string") {
    return scpClaim.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  }

  return [];
}

function claimAsString(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function persistedAccessTokenRecord(record: PersistedAccessTokenRecord): AccessTokenRecord {
  return {
    clientId: record.clientId,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    resource: urlFromStoredResource(record.resource),
  };
}

function persistedRefreshTokenRecord(record: PersistedRefreshTokenRecord): RefreshTokenRecord {
  return {
    clientId: record.clientId,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    resource: urlFromStoredResource(record.resource),
  };
}

function urlFromStoredResource(resource: string | undefined): URL | undefined {
  if (!resource) return undefined;
  return new URL(resource);
}
