-- Reviews table and aggregate trigger
-- Run this in the Supabase SQL Editor after 001_initial_schema.sql.

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  reviewer_id uuid not null references public.profiles(id) on delete cascade,
  supplier_id int not null references public.suppliers(id) on delete cascade,
  rating int not null check (rating >= 1 and rating <= 5),
  body text not null default '',
  created_at timestamptz default now(),
  unique(reviewer_id, supplier_id)
);

alter table public.reviews enable row level security;

create policy "Anyone can read reviews"
  on public.reviews for select using (true);
create policy "Authenticated users can insert own review"
  on public.reviews for insert with check (auth.uid() = reviewer_id);
create policy "Users can update own review"
  on public.reviews for update using (auth.uid() = reviewer_id);
create policy "Users can delete own review"
  on public.reviews for delete using (auth.uid() = reviewer_id);

-- Recalculate supplier aggregate rating + count after any review change
create or replace function public.refresh_supplier_rating()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  sid int;
begin
  sid := coalesce(new.supplier_id, old.supplier_id);
  update public.suppliers
  set rating  = coalesce((select round(avg(r.rating)::numeric, 2) from public.reviews r where r.supplier_id = sid), 0),
      reviews = coalesce((select count(*)::int from public.reviews r where r.supplier_id = sid), 0)
  where id = sid;
  return null;
end;
$$;

drop trigger if exists trg_refresh_supplier_rating on public.reviews;
create trigger trg_refresh_supplier_rating
  after insert or update or delete on public.reviews
  for each row execute procedure public.refresh_supplier_rating();
