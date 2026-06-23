create table if not exists agent_runs (
  id text primary key,
  tenant_id text not null,
  user_id text not null,
  automation_run_id text unique references automation_runs(id) on delete set null,
  workspace_session_id text,
  workflow_id text not null,
  status text not null default 'queued' check (
    status in ('queued', 'claiming', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'timed_out')
  ),
  attempt integer not null default 1 check (attempt >= 1),
  permission_profile text not null default 'workspace_write' check (
    permission_profile in ('read_only', 'workspace_write', 'trusted_local')
  ),
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null
);

create index if not exists agent_runs_owner_status_created_idx
  on agent_runs(tenant_id, user_id, status, created_at desc);

create index if not exists agent_runs_automation_run_idx
  on agent_runs(automation_run_id)
  where automation_run_id is not null;

create index if not exists agent_runs_workspace_idx
  on agent_runs(tenant_id, user_id, workspace_session_id, created_at desc)
  where workspace_session_id is not null;

create table if not exists agent_run_events (
  id text primary key,
  agent_run_id text not null references agent_runs(id) on delete cascade,
  seq integer not null check (seq >= 1),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  unique(agent_run_id, seq)
);

create index if not exists agent_run_events_run_seq_idx
  on agent_run_events(agent_run_id, seq asc);

create table if not exists agent_tool_calls (
  id text primary key,
  agent_run_id text not null references agent_runs(id) on delete cascade,
  tool_name text not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'blocked')),
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  input jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz
);

create index if not exists agent_tool_calls_run_started_idx
  on agent_tool_calls(agent_run_id, started_at asc);

create table if not exists agent_runtime_hooks (
  id text primary key,
  agent_run_id text references agent_runs(id) on delete cascade,
  hook_event_name text not null check (
    hook_event_name in ('PreToolUse', 'PostToolUse', 'PermissionRequest', 'PostCompact', 'Stop')
  ),
  decision text not null check (decision in ('allow', 'block', 'ask', 'deny', 'audit_only')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null
);

create index if not exists agent_runtime_hooks_run_created_idx
  on agent_runtime_hooks(agent_run_id, created_at asc)
  where agent_run_id is not null;
