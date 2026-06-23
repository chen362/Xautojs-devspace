create table if not exists cloud_devices (
  tenant_id text not null,
  user_id text not null,
  device_id text not null,
  label text,
  capabilities jsonb not null default '[]'::jsonb,
  status text not null default 'offline' check (status in ('online', 'offline', 'revoked')),
  registered_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz,
  primary key (tenant_id, user_id, device_id)
);

create index if not exists cloud_devices_owner_status_seen_idx
  on cloud_devices(tenant_id, user_id, status, last_seen_at desc);

create table if not exists cloud_workspace_routes (
  tenant_id text not null,
  user_id text not null,
  workspace_id text not null,
  mcp_session_id text not null,
  conversation_session_id text,
  device_id text not null,
  workspace_ref text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  created_at timestamptz not null,
  last_routed_at timestamptz,
  expires_at timestamptz,
  primary key (tenant_id, user_id, workspace_id),
  foreign key (tenant_id, user_id, device_id)
    references cloud_devices(tenant_id, user_id, device_id)
    on delete cascade
);

create index if not exists cloud_workspace_routes_owner_mcp_idx
  on cloud_workspace_routes(tenant_id, user_id, mcp_session_id, status, created_at desc);

create index if not exists cloud_workspace_routes_device_idx
  on cloud_workspace_routes(tenant_id, user_id, device_id, status, created_at desc);

create table if not exists cloud_tool_calls (
  tenant_id text not null,
  user_id text not null,
  tool_call_id text not null,
  mcp_session_id text not null,
  conversation_session_id text,
  workspace_id text not null,
  device_id text not null,
  tool_name text,
  status text not null default 'routed' check (status in ('routed', 'completed', 'failed', 'cancelled')),
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  deadline_at timestamptz,
  completed_at timestamptz,
  primary key (tenant_id, user_id, tool_call_id),
  foreign key (tenant_id, user_id, workspace_id)
    references cloud_workspace_routes(tenant_id, user_id, workspace_id)
    on delete cascade
);

create index if not exists cloud_tool_calls_workspace_created_idx
  on cloud_tool_calls(tenant_id, user_id, workspace_id, created_at desc);

create index if not exists cloud_tool_calls_device_status_idx
  on cloud_tool_calls(tenant_id, user_id, device_id, status, created_at desc);
