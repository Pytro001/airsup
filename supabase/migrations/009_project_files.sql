-- Project file attachments (Storage + metadata). Run in Supabase SQL Editor if not using CLI.

-- 1. Private bucket for buyer project files (access via signed URLs from API only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-files', 'project-files', false, 52428800, null)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- 2. Metadata table
create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text default '',
  bytes int default 0,
  source text not null default 'chat' check (source in ('chat', 'manual')),
  created_at timestamptz default now()
);

create index if not exists project_files_user_id_idx on public.project_files (user_id);
create index if not exists project_files_project_id_idx on public.project_files (project_id);

alter table public.project_files enable row level security;

-- Buyers: full access to own files
create policy "Users manage own project_files"
  on public.project_files for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Matched suppliers: read files for projects they are matched on
create policy "Suppliers read project_files for matched projects"
  on public.project_files for select
  using (
    project_id is not null
    and exists (
      select 1
      from public.matches m
      inner join public.factories f on f.id = m.factory_id
      where m.project_id = project_files.project_id
        and f.user_id is not null
        and f.user_id = auth.uid()
    )
  );

-- Storage access: uploads and signed URLs go through the API (service role), which bypasses Storage RLS.
