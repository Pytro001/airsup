-- Add unique constraint on user_id for companies (one company per user for now)
create unique index if not exists companies_user_id_unique on public.companies (user_id);
