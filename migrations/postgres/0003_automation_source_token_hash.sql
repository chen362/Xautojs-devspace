alter table automation_sources
  add column if not exists token_hash text;

create unique index if not exists automation_sources_token_hash_uidx
  on automation_sources(token_hash)
  where token_hash is not null;

create index if not exists automation_sources_kind_status_idx
  on automation_sources(kind, status, updated_at desc);
