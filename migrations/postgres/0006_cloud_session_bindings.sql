create table if not exists cloud_session_bindings (
  tenant_id text not null,
  user_id text not null,
  mcp_session_id text not null,
  conversation_session_id text,
  device_id text not null,
  bound_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz,
  primary key (tenant_id, user_id, mcp_session_id),
  foreign key (tenant_id, user_id, device_id)
    references cloud_devices(tenant_id, user_id, device_id)
    on delete cascade
);

create index if not exists cloud_session_bindings_device_seen_idx
  on cloud_session_bindings(tenant_id, user_id, device_id, last_seen_at desc);

create index if not exists cloud_session_bindings_conversation_idx
  on cloud_session_bindings(tenant_id, user_id, conversation_session_id, last_seen_at desc);
