alter table workspace_sessions
  add column if not exists mcp_session_id text;

create index if not exists workspace_sessions_owner_mcp_session_idx
  on workspace_sessions(tenant_id, user_id, mcp_session_id, last_used_at desc);
