-- Direct messaging between buyers and suppliers within a match
create table if not exists public.connection_messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  content text not null,
  created_at timestamptz default now()
);

create index if not exists idx_connection_messages_match on public.connection_messages(match_id, created_at);

alter table public.connection_messages enable row level security;

-- Buyers can read messages for matches linked to their projects
create policy "Buyers read own connection messages"
  on public.connection_messages for select
  using (
    exists (
      select 1 from public.matches m
      join public.projects p on p.id = m.project_id
      where m.id = connection_messages.match_id
        and p.user_id = auth.uid()
    )
  );

-- Suppliers can read messages for matches linked to their factory
create policy "Suppliers read own connection messages"
  on public.connection_messages for select
  using (
    exists (
      select 1 from public.matches m
      join public.factories f on f.id = m.factory_id
      where m.id = connection_messages.match_id
        and f.user_id = auth.uid()
    )
  );

-- Buyers can send messages on their matches
create policy "Buyers insert connection messages"
  on public.connection_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.matches m
      join public.projects p on p.id = m.project_id
      where m.id = connection_messages.match_id
        and p.user_id = auth.uid()
    )
  );

-- Suppliers can send messages on their matches
create policy "Suppliers insert connection messages"
  on public.connection_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.matches m
      join public.factories f on f.id = m.factory_id
      where m.id = connection_messages.match_id
        and f.user_id = auth.uid()
    )
  );
