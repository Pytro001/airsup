-- Pipeline steps (1–3) and coordination mode for Supi vs AI intake chat.

alter table public.projects
  add column if not exists pipeline_step smallint not null default 1
    check (pipeline_step >= 1 and pipeline_step <= 3);

alter table public.projects
  add column if not exists coordination_mode text not null default 'supi_manual'
    check (coordination_mode in ('ai', 'supi_manual'));

-- Existing projects: keep current AI chat behavior.
update public.projects
set coordination_mode = 'ai'
where coordination_mode = 'supi_manual';

comment on column public.projects.pipeline_step is 'Customer-facing progress 1–3 toward sample delivery; admin advances.';
comment on column public.projects.coordination_mode is 'ai = Claude intake replies; supi_manual = human via admin as Supi.';
