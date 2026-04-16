-- Allow suppliers to own a factory profile
alter table public.factories add column if not exists user_id uuid references public.profiles(id) on delete set null;
create unique index if not exists factories_user_id_unique on public.factories (user_id) where user_id is not null;

-- Suppliers can manage their own factory
create policy "Suppliers can insert own factory" on public.factories for insert with check (auth.uid() = user_id);
create policy "Suppliers can update own factory" on public.factories for update using (auth.uid() = user_id);
