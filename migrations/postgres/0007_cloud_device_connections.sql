create table if not exists cloud_device_connections (
  tenant_id text not null,
  user_id text not null,
  device_id text not null,
  connection_id text not null,
  status text not null default 'offline' check (status in ('online', 'offline')),
  capabilities jsonb not null default '[]'::jsonb,
  desktop_instance_id text,
  agent_version text,
  connected_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  disconnected_at timestamptz,
  primary key (tenant_id, user_id, device_id),
  foreign key (tenant_id, user_id, device_id)
    references cloud_devices(tenant_id, user_id, device_id)
    on delete cascade
);

create index if not exists cloud_device_connections_owner_status_heartbeat_idx
  on cloud_device_connections(tenant_id, user_id, status, last_heartbeat_at desc);

create index if not exists cloud_device_connections_connection_idx
  on cloud_device_connections(tenant_id, user_id, connection_id);
