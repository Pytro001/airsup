-- ============================================================
-- Airsup platform pivot: AI-driven sourcing
-- Self-contained — run this single file in Supabase SQL Editor.
-- It creates all tables from scratch (profiles through visit_stops).
-- ============================================================

-- 1. Profiles (one per auth user, auto-created via trigger)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar_letter text default '',
  role text default 'customer' check (role in ('customer','supplier')),
  location text default '',
  headline text default '',
  bio text default '',
  company text default '',
  verified boolean default false,
  phone text default '',
  whatsapp_id text default '',
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Anyone can read profiles"
  on public.profiles for select using (true);
create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);
create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- 2. User settings
create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  legal_name text default '',
  preferred_name text default '',
  email text default '',
  phone text default '',
  company text default '',
  timezone text default 'Europe/Berlin',
  email_new_messages boolean default true,
  email_digest boolean default false,
  profile_visibility text default 'matched',
  show_phone_to_matched boolean default true,
  updated_at timestamptz default now()
);

alter table public.user_settings enable row level security;

create policy "Users can read own settings"
  on public.user_settings for select using (auth.uid() = user_id);
create policy "Users can update own settings"
  on public.user_settings for update using (auth.uid() = user_id);
create policy "Users can insert own settings"
  on public.user_settings for insert with check (auth.uid() = user_id);

-- 3. Auto-create profile + settings when a user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_letter, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    upper(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.email), 1)),
    'customer'
  );
  insert into public.user_settings (user_id, email)
  values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- New platform tables
-- ============================================================

-- 4. Companies — user's business info + AI knowledge store
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default '',
  industry text default '',
  description text default '',
  location text default '',
  ai_knowledge jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.companies enable row level security;
create policy "Users can read own companies" on public.companies for select using (auth.uid() = user_id);
create policy "Users can insert own companies" on public.companies for insert with check (auth.uid() = user_id);
create policy "Users can update own companies" on public.companies for update using (auth.uid() = user_id);

-- 5. Projects — sourcing requests
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  title text not null,
  description text default '',
  requirements jsonb default '{}',
  ai_summary jsonb default '{}',
  status text not null default 'intake'
    check (status in ('intake', 'searching', 'negotiating', 'matched', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.projects enable row level security;
create policy "Users can read own projects" on public.projects for select using (auth.uid() = user_id);
create policy "Users can insert own projects" on public.projects for insert with check (auth.uid() = user_id);
create policy "Users can update own projects" on public.projects for update using (auth.uid() = user_id);

-- 6. Conversations — AI chat history
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

alter table public.conversations enable row level security;
create policy "Users can read own conversations" on public.conversations for select using (auth.uid() = user_id);
create policy "Users can insert own conversations" on public.conversations for insert with check (auth.uid() = user_id);

-- 7. Factories — manufacturing partners
create table if not exists public.factories (
  id serial primary key,
  name text not null,
  location text not null,
  category text default '',
  capabilities jsonb default '{}',
  contact_info jsonb default '{}',
  whatsapp_id text default '',
  trust_score numeric(3,2) default 5.00,
  active boolean default true,
  created_at timestamptz default now()
);

alter table public.factories enable row level security;
create policy "Anyone can read active factories" on public.factories for select using (active = true);

-- 8. Factory searches — AI-initiated search jobs
create table if not exists public.factory_searches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  search_criteria jsonb default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'failed')),
  created_at timestamptz default now()
);

alter table public.factory_searches enable row level security;
create policy "Users can read own searches" on public.factory_searches for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- 9. Outreach logs — AI communication with factories
create table if not exists public.outreach_logs (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references public.factory_searches(id) on delete cascade,
  factory_id int not null references public.factories(id) on delete cascade,
  stage text not null default 'initial'
    check (stage in ('initial', 'briefed', 'negotiating', 'quoted', 'accepted', 'rejected')),
  ai_messages jsonb default '[]',
  outcome text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.outreach_logs enable row level security;

-- 10. Matches — confirmed factory-user connections
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  factory_id int not null references public.factories(id) on delete cascade,
  quote jsonb default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'intro_sent', 'active', 'in_production', 'completed', 'disputed', 'cancelled')),
  wa_group_id text default '',
  context_summary jsonb default '{}',
  created_at timestamptz default now()
);

alter table public.matches enable row level security;
create policy "Users can read own matches" on public.matches for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));

-- 11. Payments — escrow tracking
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  amount_cents int not null,
  currency text not null default 'usd',
  stripe_intent_id text default '',
  status text not null default 'pending'
    check (status in ('pending', 'held', 'released', 'refunded', 'failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.payments enable row level security;
create policy "Users can read own payments" on public.payments for select
  using (exists (
    select 1 from public.matches m
    join public.projects p on p.id = m.project_id
    where m.id = match_id and p.user_id = auth.uid()
  ));

-- 12. Timelines — milestone enforcement
create table if not exists public.timelines (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  milestone text not null,
  due_date date not null,
  status text not null default 'upcoming'
    check (status in ('upcoming', 'on_track', 'at_risk', 'overdue', 'completed')),
  created_at timestamptz default now()
);

alter table public.timelines enable row level security;
create policy "Users can read own timelines" on public.timelines for select
  using (exists (
    select 1 from public.matches m
    join public.projects p on p.id = m.project_id
    where m.id = match_id and p.user_id = auth.uid()
  ));

-- 13. Visit plans — premium factory visit planner
create table if not exists public.visit_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  travel_date date not null,
  region text default '',
  route jsonb default '{}',
  created_at timestamptz default now()
);

alter table public.visit_plans enable row level security;
create policy "Users can manage own visit_plans" on public.visit_plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 14. Visit stops — individual factory visits within a plan
create table if not exists public.visit_stops (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.visit_plans(id) on delete cascade,
  factory_id int not null references public.factories(id) on delete cascade,
  scheduled_time time,
  status text not null default 'planned'
    check (status in ('planned', 'confirmed', 'completed', 'cancelled')),
  notes text default '',
  created_at timestamptz default now()
);

alter table public.visit_stops enable row level security;
create policy "Users can manage own visit_stops" on public.visit_stops
  for all using (exists (select 1 from public.visit_plans vp where vp.id = plan_id and vp.user_id = auth.uid()))
  with check (exists (select 1 from public.visit_plans vp where vp.id = plan_id and vp.user_id = auth.uid()));
