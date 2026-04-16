-- Improve new-user profile names from Google OAuth (name vs full_name) and keep trigger idempotent-friendly
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  dn text;
  av text;
begin
  dn := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    new.raw_user_meta_data ->> 'preferred_username',
    split_part(new.email, '@', 1)
  );
  av := upper(left(dn, 1));
  insert into public.profiles (id, display_name, avatar_letter, role)
  values (new.id, dn, av, 'customer')
  on conflict (id) do update set
    display_name = excluded.display_name,
    avatar_letter = excluded.avatar_letter;

  insert into public.user_settings (user_id, email, preferred_name)
  values (new.id, new.email, dn)
  on conflict (user_id) do update set
    email = excluded.email,
    preferred_name = excluded.preferred_name;

  return new;
end;
$$;
