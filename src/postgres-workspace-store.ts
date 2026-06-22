import type { PostgresDatabaseConfig } from "./db/types.js";
import type { WorkspaceIdentity } from "./identity.js";
import type { WorkspaceMode, WorkspaceSession, WorkspaceStore } from "./workspace-store.js";

export class PostgresWorkspaceStoreNotImplementedError extends Error {
  constructor(operation: string) {
    super(`PostgresWorkspaceStore.${operation} is not implemented yet.`);
    this.name = "PostgresWorkspaceStoreNotImplementedError";
  }
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(readonly config: PostgresDatabaseConfig) {}

  createSession(_input: {
    owner: WorkspaceIdentity;
    id: string;
    root: string;
    mode?: WorkspaceMode;
    sourceRoot?: string;
    baseRef?: string;
    baseSha?: string;
    managed?: boolean;
  }): WorkspaceSession {
    throw new PostgresWorkspaceStoreNotImplementedError("createSession");
  }

  getSession(_id: string, _owner: WorkspaceIdentity): WorkspaceSession | undefined {
    throw new PostgresWorkspaceStoreNotImplementedError("getSession");
  }

  touchSession(_id: string, _owner: WorkspaceIdentity): void {
    throw new PostgresWorkspaceStoreNotImplementedError("touchSession");
  }

  close(): void {
    // Connection pooling is added with the concrete Postgres implementation.
  }
}
