create table if not exists workspace_sessions (
  id text primary key,
  tenant_id text not null default 'local',
  user_id text not null default 'owner',
  root text not null,
  status text not null default 'active',
  mode text not null default 'checkout' check (mode in ('checkout', 'worktree')),
  source_root text,
  base_ref text,
  base_sha text,
  managed boolean not null default false,
  created_at timestamptz not null,
  last_used_at timestamptz not null
);

create index if not exists workspace_sessions_owner_idx
  on workspace_sessions(tenant_id, user_id, last_used_at desc);

create index if not exists workspace_sessions_owner_root_idx
  on workspace_sessions(tenant_id, user_id, root, last_used_at desc);

create index if not exists workspace_sessions_owner_status_idx
  on workspace_sessions(tenant_id, user_id, status, last_used_at desc);

create table if not exists loaded_agent_files (
  workspace_session_id text not null references workspace_sessions(id) on delete cascade,
  path text not null,
  content_hash text not null,
  content text not null,
  loaded_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (workspace_session_id, path)
);

create index if not exists loaded_agent_files_path_idx
  on loaded_agent_files(path);
