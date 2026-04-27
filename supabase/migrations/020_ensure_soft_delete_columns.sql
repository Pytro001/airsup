-- Idempotent re-apply of soft-delete columns (same as 014). Use if production never ran 014
-- or PostgREST reports "Could not find the 'deleted_at' column ... in the schema cache".

alter table public.profiles add column if not exists deleted_at timestamptz default null;
alter table public.factories add column if not exists deleted_at timestamptz default null;

create index if not exists profiles_deleted_at_idx on public.profiles (deleted_at) where deleted_at is not null;
create index if not exists factories_deleted_at_idx on public.factories (deleted_at) where deleted_at is not null;
