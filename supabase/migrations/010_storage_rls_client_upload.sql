-- Browser uploads large files directly to Storage (not through Vercel).
-- Path: {auth.uid()}/{project_uuid|orphan}/{uuid}_{filename}

drop policy if exists "project_files_storage_insert_own" on storage.objects;
drop policy if exists "project_files_storage_select_own" on storage.objects;
drop policy if exists "project_files_storage_delete_own" on storage.objects;

create policy "project_files_storage_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'project-files'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

create policy "project_files_storage_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'project-files'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );

create policy "project_files_storage_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'project-files'
    and (string_to_array(name, '/'))[1] = auth.uid()::text
  );
