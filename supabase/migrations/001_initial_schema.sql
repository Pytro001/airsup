-- Airsup initial schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query).

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
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select using (auth.uid() = id);
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

-- 3. Saved factories
create table if not exists public.saved_factories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  factory_id int not null,
  saved_at timestamptz default now(),
  unique(user_id, factory_id)
);

alter table public.saved_factories enable row level security;

create policy "Users can read own saved"
  on public.saved_factories for select using (auth.uid() = user_id);
create policy "Users can insert own saved"
  on public.saved_factories for insert with check (auth.uid() = user_id);
create policy "Users can delete own saved"
  on public.saved_factories for delete using (auth.uid() = user_id);

-- 4. Messages
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  factory_id int not null,
  direction text not null check (direction in ('sent','received')),
  body text not null,
  created_at timestamptz default now(),
  read_at timestamptz
);

alter table public.messages enable row level security;

create policy "Users can read own messages"
  on public.messages for select using (auth.uid() = sender_id);
create policy "Users can insert own messages"
  on public.messages for insert with check (auth.uid() = sender_id);
create policy "Users can update own messages"
  on public.messages for update using (auth.uid() = sender_id);

-- 5. Suppliers (listings — seed demo data here; is_demo flag for cleanup)
create table if not exists public.suppliers (
  id int primary key,
  name text not null,
  location text not null,
  category text not null,
  moq text,
  lead_time text,
  rating numeric(3,2) default 0,
  reviews int default 0,
  badge text default '',
  price text default '',
  img text default '',
  tags jsonb default '[]',
  verified boolean default false,
  response_hours int default 24,
  contact text default '',
  profile_id text,
  is_demo boolean default true,
  created_at timestamptz default now()
);

alter table public.suppliers enable row level security;

create policy "Anyone can read suppliers"
  on public.suppliers for select using (true);

-- Seed demo factories
insert into public.suppliers (id,name,location,category,moq,lead_time,rating,reviews,badge,price,img,tags,verified,response_hours,contact,profile_id,is_demo) values
(1,'Shenzhen ProTech Electronics','Shenzhen, China','Electronics','500 units','15 days',4.97,214,'Top Manufacturer','From $0.80 / unit','assets/placeholders/factory-01-electronics.png','["PCB assembly","IoT devices","Smart hardware"]',true,3,'Wei Chen','pf-supplier-wei',true),
(2,'Guangzhou Precision Metals','Guangzhou, China','Metal Parts','200 units','10 days',4.94,178,'Top Manufacturer','From $2.40 / unit','assets/placeholders/factory-02-metal.png','["CNC machining","Sheet metal","Aluminum"]',true,2,'Lin Yao',null,true),
(3,'Yiwu Fashion Collective','Yiwu, China','Apparel','300 units','21 days',4.88,312,'Top Manufacturer','From $4.20 / unit','assets/placeholders/factory-03-apparel.png','["Custom apparel","Embroidery","Private label"]',true,5,'Anna Guo',null,true),
(4,'Dongguan Plastics Mfg','Dongguan, China','Plastics','1,000 units','18 days',4.92,97,'Top Manufacturer','From $0.30 / unit','assets/placeholders/factory-04-plastics.png','["Injection molding","ABS / PP","Custom colors"]',true,4,'Jason Hu',null,true),
(5,'Hangzhou Smart Packaging','Hangzhou, China','Packaging','5,000 units','12 days',5.0,63,'Top Manufacturer','From $0.12 / unit','assets/placeholders/factory-05-packaging.png','["Custom boxes","Eco-friendly","Branding"]',true,3,'Mira Song',null,true),
(6,'Foshan Furniture Works','Foshan, China','Furniture','50 units','30 days',4.85,145,'Top Manufacturer','From $38 / unit','assets/placeholders/factory-06-furniture.png','["Wood & metal","OEM","Custom design"]',false,8,'David Zhou',null,true),
(7,'Chengdu Auto Components','Chengdu, China','Auto Parts','100 units','25 days',4.9,89,'Top Manufacturer','From $12 / unit','assets/placeholders/factory-07-auto.png','["Interior parts","Stamping","OEM grade"]',true,6,'Rui Zhang',null,true),
(8,'Ningbo Lighting Factory','Ningbo, China','Lighting','500 units','14 days',4.78,201,'Top Manufacturer','From $1.80 / unit','assets/placeholders/factory-08-lighting.png','["LED","Smart lighting","Certified"]',false,4,'Elena Wu',null,true)
on conflict (id) do nothing;

-- 6. Auto-create profile row when a user signs up
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
