import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createOidcIdentity } from "./identity.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const root = await mkdtemp(join(tmpdir(), "devspace-workspace-identity-test-"));
const stateDir = join(root, ".state");
const projectRoot = join(root, "project");
const store = new SqliteWorkspaceStore(stateDir);

try {
  await mkdir(projectRoot);
  const config = loadConfig({
    DEVSPACE_ALLOWED_ROOTS: root,
    DEVSPACE_WORKTREE_ROOT: join(root, ".devspace", "worktrees"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
    PORT: "1",
  });
  const alice = createOidcIdentity({
    issuer: "https://auth.example.com",
    subject: "alice",
    tenantExternalId: "tenant-a",
    scopes: ["devspace"],
  });
  const bob = createOidcIdentity({
    issuer: "https://auth.example.com",
    subject: "bob",
    tenantExternalId: "tenant-a",
    scopes: ["devspace"],
  });

  const aliceRegistry = new WorkspaceRegistry(config, store, alice);
  const aliceContext = await aliceRegistry.openWorkspace(projectRoot);
  assert.equal(aliceContext.workspace.owner.tenantId, alice.tenantId);
  assert.equal(aliceContext.workspace.owner.userId, alice.userId);

  assert.equal(store.getSession(aliceContext.workspace.id, alice)?.id, aliceContext.workspace.id);
  assert.equal(store.getSession(aliceContext.workspace.id, bob), undefined);

  const bobRegistry = new WorkspaceRegistry(config, store, bob);
  assert.throws(
    () => bobRegistry.getWorkspace(aliceContext.workspace.id),
    /Unknown workspaceId/,
  );

  const restoredAlice = new WorkspaceRegistry(config, store, alice).getWorkspace(aliceContext.workspace.id);
  assert.equal(restoredAlice.root, projectRoot);
  assert.equal(restoredAlice.owner.userId, alice.userId);
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
