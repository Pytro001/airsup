-- Re-apply project-files Storage RLS using Supabase-recommended patterns:
-- (storage.foldername(name))[1] and auth.jwt()->>'sub' (aligns with Storage docs; avoids
-- rare cases where auth.uid() is not set in the storage.objects policy context while the JWT has sub).
-- Replaces split_part-based policies from 010/011; safe to run if those already exist.

drop policy if exists "project_files_storage_insert_own" on storage.objects;
drop policy if exists "project_files_storage_select_own" on storage.objects;
drop policy if exists "project_files_storage_delete_own" on storage.objects;

create policy "project_files_storage_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub')
  );

create policy "project_files_storage_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub')
  );

create policy "project_files_storage_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'project-files'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub')
  );
