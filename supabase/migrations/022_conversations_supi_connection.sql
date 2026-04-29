-- User-level Supi thread in conversations (project_id null, separate from main intake chat).
alter table public.conversations
  add column if not exists is_supi_connection boolean not null default false;

create index if not exists idx_conversations_user_supi
  on public.conversations (user_id, created_at desc)
  where is_supi_connection = true;

comment on column public.conversations.is_supi_connection is 'True for the Connections / Supi thread; false for project chat and main intake chat.';
