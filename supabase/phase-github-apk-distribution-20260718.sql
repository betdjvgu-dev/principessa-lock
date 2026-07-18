begin;

alter table public.app_releases
  add column if not exists download_url text;

alter table public.app_releases
  alter column storage_path drop not null;

commit;
