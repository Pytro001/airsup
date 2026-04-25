-- Brief import from external AI chats (ChatGPT / Claude / Grok share links or paste)
alter table public.projects
  add column if not exists brief_source_type text,
  add column if not exists brief_source_url text,
  add column if not exists brief_raw text;

comment on column public.projects.brief_source_type is 'How the brief was provided: url | text | file';
comment on column public.projects.brief_source_url is 'Public share URL when source is url';
comment on column public.projects.brief_raw is 'Raw conversation text (truncated server-side)';
