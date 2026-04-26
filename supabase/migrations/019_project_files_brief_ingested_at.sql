-- Track which uploaded files have had their text merged into projects.brief_raw / AI fields (re-ingest idempotency).
alter table public.project_files add column if not exists brief_ingested_at timestamptz;

comment on column public.project_files.brief_ingested_at is 'Set when server-side text extraction and brief merge ran for this row; null means pending for POST /reingest-files.';
