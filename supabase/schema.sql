create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.session_requests (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  requested_days integer not null,
  daily_limit_minutes integer not null,
  forced_sleep_enabled boolean not null default false,
  status text not null default 'pending',
  activation_code_hash text,
  activation_code_expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_requests_status_check
    check (status in ('pending', 'approved', 'rejected', 'activated', 'expired')),
  constraint session_requests_requested_days_check
    check (requested_days between 1 and 30),
  constraint session_requests_daily_limit_minutes_check
    check (daily_limit_minutes between 5 and 90)
);

create unique index if not exists session_requests_activation_code_hash_key
  on public.session_requests (activation_code_hash)
  where activation_code_hash is not null;

create index if not exists session_requests_status_created_at_idx
  on public.session_requests (status, created_at desc);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  device_name text not null,
  platform text not null default 'android',
  timezone text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.session_requests(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  session_days integer not null,
  daily_limit_minutes integer not null,
  forced_sleep_enabled boolean not null default false,
  timezone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'active',
  activated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sessions_status_check
    check (status in ('active', 'completed', 'revoked')),
  constraint sessions_session_days_check
    check (session_days between 1 and 30),
  constraint sessions_daily_limit_minutes_check
    check (daily_limit_minutes between 5 and 90),
  constraint sessions_request_id_unique
    unique (request_id)
);

create index if not exists sessions_device_id_idx
  on public.sessions (device_id, created_at desc);

create index if not exists sessions_status_idx
  on public.sessions (status, created_at desc);

create table if not exists public.session_daily_usage (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  local_date date not null,
  used_minutes integer not null default 0,
  limit_minutes integer not null,
  reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_daily_usage_used_minutes_check
    check (used_minutes >= 0),
  constraint session_daily_usage_limit_minutes_check
    check (limit_minutes between 5 and 90),
  constraint session_daily_usage_session_id_local_date_key
    unique (session_id, local_date)
);

create index if not exists session_daily_usage_session_id_idx
  on public.session_daily_usage (session_id, local_date desc);

drop trigger if exists set_session_requests_updated_at on public.session_requests;
create trigger set_session_requests_updated_at
before update on public.session_requests
for each row
execute function public.set_updated_at();

drop trigger if exists set_session_daily_usage_updated_at on public.session_daily_usage;
create trigger set_session_daily_usage_updated_at
before update on public.session_daily_usage
for each row
execute function public.set_updated_at();

