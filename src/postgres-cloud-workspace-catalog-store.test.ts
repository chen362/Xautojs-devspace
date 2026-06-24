import assert from "node:assert/strict";
import type { WorkspaceIdentity } from "./identity.js";
import {
  PostgresCloudWorkspaceCatalogStore,
  type PostgresCloudWorkspaceCatalogQuery,
  type PostgresCloudWorkspaceCatalogQueryResult,
  type PostgresCloudWorkspaceCatalogQueryRunner,
} from "./postgres-cloud-workspace-catalog-store.js";

interface StoredCatalogRow {
  tenant_id: string;
  user_id: string;
  device_id: string;
  workspace_ref: string;
  display_name: string;
  root_label: string;
  capabilities: unknown;
  catalog_version: string | null;
  last_seen_at: string;
}

const owner: WorkspaceIdentity = { tenantId: "tenant_catalog_pg", userId: "user_catalog_pg" };
const rows: StoredCatalogRow[] = [];
const calls: PostgresCloudWorkspaceCatalogQuery[] = [];

const runner: PostgresCloudWorkspaceCatalogQueryRunner = async <Row>(
  query: PostgresCloudWorkspaceCatalogQuery,
): Promise<PostgresCloudWorkspaceCatalogQueryResult<Row>> => {
  calls.push(query);
  const normalizedSql = query.text.replace(/\s+/g, " ").trim().toLowerCase();

  if (normalizedSql.startsWith("delete from cloud_workspace_catalog")) {
    const before = rows.length;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.tenant_id === query.values[0] && row.user_id === query.values[1] && row.device_id === query.values[2]) {
        rows.splice(index, 1);
      }
    }
    return { rows: [], rowCount: before - rows.length };
  }

  if (normalizedSql.startsWith("insert into cloud_workspace_catalog")) {
    rows.push({
      tenant_id: stringValue(query.values[0]),
      user_id: stringValue(query.values[1]),
      device_id: stringValue(query.values[2]),
      workspace_ref: stringValue(query.values[3]),
      display_name: stringValue(query.values[4]),
      root_label: stringValue(query.values[5]),
      capabilities: JSON.parse(stringValue(query.values[6])) as unknown,
      catalog_version: nullableStringValue(query.values[7]),
      last_seen_at: stringValue(query.values[8]),
    });
    return { rows: [], rowCount: 1 };
  }

  if (normalizedSql.startsWith("select")) {
    const matches = rows
      .filter(
        (row) =>
          row.tenant_id === query.values[0] &&
          row.user_id === query.values[1] &&
          row.device_id === query.values[2],
      )
      .sort((left, right) => left.display_name.localeCompare(right.display_name) || left.workspace_ref.localeCompare(right.workspace_ref));
    return { rows: matches as Row[], rowCount: matches.length };
  }

  throw new Error(`Unexpected SQL: ${query.text}`);
};

const store = new PostgresCloudWorkspaceCatalogStore(
  {
    provider: "postgres",
    url: "postgres://devspace:secret@db.example.com:5432/devspace",
    sslMode: "require",
  },
  runner,
);

const first = await store.recordCatalog({
  owner,
  deviceId: "dev_catalog_pg_a",
  catalogVersion: "v1",
  now: "2026-06-24T00:00:00.000Z",
  workspaces: [
    { workspaceRef: "workspace_z", displayName: "Zeta", rootLabel: "~/zeta", capabilities: ["write", "read"] },
    { workspaceRef: "workspace_a", displayName: "Alpha", rootLabel: "~/alpha", capabilities: ["read"] },
  ],
});
assert.deepEqual(first.map((workspace) => workspace.workspaceRef), ["workspace_a", "workspace_z"]);
assert.equal(calls[1]?.text.includes("workspace_z"), false);
assert.equal(first[0]?.catalogVersion, "v1");

const second = await store.recordCatalog({
  owner,
  deviceId: "dev_catalog_pg_a",
  catalogVersion: "v2",
  now: "2026-06-24T00:00:05.000Z",
  workspaces: [{ workspaceRef: "workspace_b", displayName: "Beta", rootLabel: "~/beta", capabilities: ["read"] }],
});
assert.deepEqual(second.map((workspace) => workspace.workspaceRef), ["workspace_b"]);
assert.equal(second[0]?.lastSeenAt, "2026-06-24T00:00:05.000Z");

await store.recordCatalog({
  owner: { tenantId: owner.tenantId, userId: "user_catalog_pg_other" },
  deviceId: "dev_catalog_pg_a",
  now: "2026-06-24T00:00:06.000Z",
  workspaces: [{ workspaceRef: "workspace_other", displayName: "Other", rootLabel: "~/other", capabilities: [] }],
});
assert.deepEqual(
  (await store.listWorkspaces({ owner, deviceId: "dev_catalog_pg_a" })).map((workspace) => workspace.workspaceRef),
  ["workspace_b"],
);

await store.clearDeviceCatalog?.(owner, "dev_catalog_pg_a");
assert.deepEqual(await store.listWorkspaces({ owner, deviceId: "dev_catalog_pg_a" }), []);

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected string value: ${String(value)}`);
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value);
}
