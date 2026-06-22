import { createHash, randomBytes } from "node:crypto";

const AUTOMATION_SOURCE_TOKEN_PREFIX = "dsp_auto_";

export function generateAutomationSourceToken(): string {
  return `${AUTOMATION_SOURCE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function automationSourceTokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}
