create table if not exists cloud_workspace_catalog (
  tenant_id text not null,
  user_id text not null,
  device_id text not null,
  workspace_ref text not null,
  display_name text not null,
  root_label text not null,
  capabilities jsonb not null default '[]'::jsonb,
  catalog_version text,
  last_seen_at timestamptz not null,
  primary key (tenant_id, user_id, device_id, workspace_ref),
  foreign key (tenant_id, user_id, device_id)
    references cloud_devices (tenant_id, user_id, device_id)
    on delete cascade
);

create index if not exists cloud_workspace_catalog_device_seen_idx
  on cloud_workspace_catalog (tenant_id, user_id, device_id, last_seen_at desc);
