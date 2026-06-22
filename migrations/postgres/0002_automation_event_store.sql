create table if not exists automation_sources (
  id text primary key,
  tenant_id text not null,
  user_id text not null,
  kind text not null check (kind in ('api_trigger', 'github_webhook', 'runtime_hook')),
  name text not null,
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  secret_ref text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists automation_sources_owner_idx
  on automation_sources(tenant_id, user_id, updated_at desc);

create index if not exists automation_sources_owner_kind_status_idx
  on automation_sources(tenant_id, user_id, kind, status, updated_at desc);

create table if not exists automation_events (
  id text primary key,
  tenant_id text not null,
  user_id text not null,
  source_id text not null references automation_sources(id) on delete restrict,
  source_event_id text,
  idempotency_key text,
  request_fingerprint text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  devspace_conversation_id text,
  workspace_session_id text,
  status text not null default 'accepted' check (status in ('accepted', 'rejected')),
  received_at timestamptz not null
);

create unique index if not exists automation_events_source_event_uidx
  on automation_events(source_id, source_event_id)
  where source_event_id is not null;

create unique index if not exists automation_events_source_idempotency_uidx
  on automation_events(source_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists automation_events_owner_received_idx
  on automation_events(tenant_id, user_id, received_at desc);

create index if not exists automation_events_source_type_received_idx
  on automation_events(source_id, event_type, received_at desc);

create table if not exists automation_runs (
  id text primary key,
  tenant_id text not null,
  user_id text not null,
  event_id text not null references automation_events(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  workspace_session_id text,
  devspace_conversation_id text,
  attempt integer not null default 1 check (attempt >= 1),
  metadata jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists automation_runs_event_idx
  on automation_runs(event_id);

create index if not exists automation_runs_owner_status_created_idx
  on automation_runs(tenant_id, user_id, status, created_at desc);
