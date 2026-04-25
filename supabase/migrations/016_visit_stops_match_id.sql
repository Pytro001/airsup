-- Link visit stops to the buyer-factory match (project + context) for the planner UI and negotiation.
alter table public.visit_stops
  add column if not exists match_id uuid references public.matches(id) on delete set null;

create index if not exists visit_stops_match_id_idx on public.visit_stops(match_id);
