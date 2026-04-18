-- Supplier human gate: AI defers match creation until stage await_supplier + pending_match JSON.
-- RLS so suppliers can read outreach, searches, projects for briefed work, and matches for their factory.

alter table public.outreach_logs drop constraint if exists outreach_logs_stage_check;

alter table public.outreach_logs add constraint outreach_logs_stage_check
  check (stage in (
    'initial', 'briefed', 'negotiating', 'quoted', 'await_supplier', 'accepted', 'rejected'
  ));

alter table public.outreach_logs
  add column if not exists pending_match jsonb;

-- Factory owners: read their outreach rows
create policy "Suppliers read own outreach"
  on public.outreach_logs for select
  using (
    exists (
      select 1 from public.factories f
      where f.id = outreach_logs.factory_id and f.user_id = auth.uid()
    )
  );

-- Factory owners: read searches that have outreach to them (nested select in dashboard)
create policy "Suppliers read searches via outreach"
  on public.factory_searches for select
  using (
    exists (
      select 1 from public.outreach_logs o
      join public.factories f on f.id = o.factory_id
      where o.search_id = factory_searches.id and f.user_id = auth.uid()
    )
  );

-- Limited project visibility for suppliers briefed on a project
create policy "Suppliers read projects via outreach"
  on public.projects for select
  using (
    exists (
      select 1 from public.factory_searches s
      join public.outreach_logs o on o.search_id = s.id
      join public.factories f on f.id = o.factory_id
      where s.project_id = projects.id and f.user_id = auth.uid()
    )
  );

-- Suppliers read matches where they own the factory
create policy "Suppliers read factory matches"
  on public.matches for select
  using (
    exists (
      select 1 from public.factories f
      where f.id = matches.factory_id and f.user_id = auth.uid()
    )
  );
