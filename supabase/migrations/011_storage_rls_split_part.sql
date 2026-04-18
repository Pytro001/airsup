-- Harden Storage RLS for bucket project-files: use split_part(name, '/', 1) so the
-- first path segment always matches auth.uid() regardless of name formatting quirks.
-- Diagnose upload failures: browser Network tab — storage/v1/object/* = this policy;
-- /api/chat/register-file = project_files insert (service role; check SUPABASE_SERVICE_ROLE_KEY on Vercel).

drop policy if exists "project_files_storage_insert_own" on storage.objects;
drop policy if exists "project_files_storage_select_own" on storage.objects;
drop policy if exists "project_files_storage_delete_own" on storage.objects;

create policy "project_files_storage_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'project-files'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "project_files_storage_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'project-files'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "project_files_storage_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'project-files'
    and split_part(name, '/', 1) = auth.uid()::text
  );
