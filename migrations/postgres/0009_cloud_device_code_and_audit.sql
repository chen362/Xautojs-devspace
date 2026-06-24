create table if not exists cloud_device_authorizations (
  device_code text primary key,
  user_code text not null unique,
  status text not null,
  client_name text,
  device_id text,
  desktop_instance_id text,
  tenant_id text,
  user_id text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  interval_seconds integer not null,
  approved_at timestamptz,
  denied_at timestamptz,
  last_polled_at timestamptz
);

create index if not exists cloud_device_authorizations_user_code_idx
  on cloud_device_authorizations (user_code);

create index if not exists cloud_device_authorizations_owner_status_idx
  on cloud_device_authorizations (tenant_id, user_id, status, created_at desc);

create index if not exists cloud_device_authorizations_expiry_idx
  on cloud_device_authorizations (expires_at);

create table if not exists cloud_control_plane_audit_events (
  event_id text primary key,
  tenant_id text,
  user_id text,
  action text not null,
  status text not null,
  idempotency_key text,
  request_fingerprint text,
  result_json jsonb,
  error_code text,
  created_at timestamptz not null
);

create unique index if not exists cloud_control_plane_audit_idempotency_idx
  on cloud_control_plane_audit_events (tenant_id, user_id, action, idempotency_key)
  where idempotency_key is not null;

create index if not exists cloud_control_plane_audit_owner_created_idx
  on cloud_control_plane_audit_events (tenant_id, user_id, created_at desc);

create index if not exists cloud_control_plane_audit_action_created_idx
  on cloud_control_plane_audit_events (action, created_at desc);
