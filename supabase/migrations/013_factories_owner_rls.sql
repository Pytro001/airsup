-- Fix factory ownership: ensure user_id column exists and suppliers can
-- insert/update/read their own factory. Safe to re-run (all idempotent).

-- 1. Ensure user_id column exists
alter table public.factories
  add column if not exists user_id uuid references public.profiles(id) on delete set null;

-- 2. Unique: one factory per supplier account
create unique index if not exists factories_user_id_unique
  on public.factories (user_id)
  where user_id is not null;

-- 3. Drop old policies to avoid conflicts before re-creating
drop policy if exists "Suppliers can insert own factory"      on public.factories;
drop policy if exists "Suppliers can update own factory"      on public.factories;
drop policy if exists "Factory owner can read own factory"    on public.factories;
drop policy if exists "Anyone can read active factories"      on public.factories;

-- 4. Recreate all factory RLS policies cleanly
-- Anyone can browse active factories (AI search, buyer matching)
create policy "Anyone can read active factories"
  on public.factories for select
  using (active = true);

-- Suppliers can always read their own factory (even if active = false)
create policy "Factory owner can read own factory"
  on public.factories for select
  using (auth.uid() = user_id);

-- Suppliers can create their own factory row
create policy "Suppliers can insert own factory"
  on public.factories for insert
  with check (auth.uid() = user_id);

-- Suppliers can edit their own factory
create policy "Suppliers can update own factory"
  on public.factories for update
  using (auth.uid() = user_id);
