-- Buyer route notes + supplier confirmation pipeline for visit stops
alter table public.visit_plans
  add column if not exists route_feedback text default '',
  add column if not exists route_feedback_at timestamptz;

alter table public.visit_stops
  add column if not exists confirmation_status text not null default 'draft',
  add column if not exists supplier_proposed_time text,
  add column if not exists supplier_counter_message text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'visit_stops_confirmation_status_check'
  ) then
    alter table public.visit_stops
      add constraint visit_stops_confirmation_status_check
      check (confirmation_status in ('draft', 'pending_supplier', 'counter_proposed', 'confirmed', 'declined'));
  end if;
end $$;

-- One-time: rows that existed before this workflow shipped are treated as confirmed
update public.visit_stops set confirmation_status = 'confirmed';

comment on column public.visit_stops.confirmation_status is 'draft: buyer only; pending_supplier: sent to factory; counter_proposed: factory suggested other time; confirmed: on calendar; declined: factory declined';
