-- Older DBs may lack metadata on conversations (required by API select/insert)
alter table public.conversations add column if not exists metadata jsonb default '{}';
