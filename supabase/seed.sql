-- Diverse demo factories for local/staging matching (idempotent by name).
-- Run after migrations: psql or Supabase SQL editor.

insert into public.factories (name, location, category, capabilities, contact_info, active)
select 'Shenzhen Rapid PCB House',
  'Shenzhen, China',
  'PCB assembly',
  '{"description":"FR4 PCBs, SMT, BGA, 2–24 layer, quick-turn prototypes through 10k panels; DFM feedback"}'::jsonb,
  '{"name":"Engineering","email":"eng@example-pcb.local"}'::jsonb,
  true
where not exists (select 1 from public.factories f where f.name = 'Shenzhen Rapid PCB House');

insert into public.factories (name, location, category, capabilities, contact_info, active)
select 'Dongguan Injection Molding Partners',
  'Dongguan, China',
  'Injection molding',
  '{"description":"ABS/PC/PP/TPE, tool design, high cavitation molds, cosmetic Class A surfaces, automotive-grade"}'::jsonb,
  '{"name":"Tooling","email":"tooling@example-mold.local"}'::jsonb,
  true
where not exists (select 1 from public.factories f where f.name = 'Dongguan Injection Molding Partners');

insert into public.factories (name, location, category, capabilities, contact_info, active)
select 'Porto Apparel Atelier',
  'Porto, Portugal',
  'Cut and sew apparel',
  '{"description":"Pattern making, grading, small-batch cut-and-sew, knits and wovens, sustainable fibers"}'::jsonb,
  '{"name":"Studio","email":"studio@example-apparel.local"}'::jsonb,
  true
where not exists (select 1 from public.factories f where f.name = 'Porto Apparel Atelier');

insert into public.factories (name, location, category, capabilities, contact_info, active)
select 'Munich Precision CNC',
  'Munich, Germany',
  'CNC machining',
  '{"description":"5-axis aluminum and steel, tight tolerances, aerospace-style QA, short runs"}'::jsonb,
  '{"name":"CAM","email":"cam@example-cnc.local"}'::jsonb,
  true
where not exists (select 1 from public.factories f where f.name = 'Munich Precision CNC');

insert into public.factories (name, location, category, capabilities, contact_info, active)
select 'Hanoi EMS Electronics',
  'Hanoi, Vietnam',
  'Electronics assembly',
  '{"description":"Box build, cable harness, test fixtures, consumer and industrial IoT assembly"}'::jsonb,
  '{"name":"PMO","email":"projects@example-ems.local"}'::jsonb,
  true
where not exists (select 1 from public.factories f where f.name = 'Hanoi EMS Electronics');
