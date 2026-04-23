-- Add soft-delete column to profiles and factories
alter table public.profiles  add column if not exists deleted_at timestamptz default null;
alter table public.factories add column if not exists deleted_at timestamptz default null;

-- Index for fast bin queries
create index if not exists profiles_deleted_at_idx  on public.profiles  (deleted_at) where deleted_at is not null;
create index if not exists factories_deleted_at_idx on public.factories (deleted_at) where deleted_at is not null;
