begin;

alter table public.session_requests
  add column if not exists screen_time_enabled boolean not null default true;

alter table public.session_requests
  add column if not exists always_allowed_package text;

alter table public.sessions
  add column if not exists screen_time_enabled boolean not null default true;

alter table public.sessions
  add column if not exists always_allowed_package text;

commit;
